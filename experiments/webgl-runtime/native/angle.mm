// SPDX-License-Identifier: MIT
#if !defined(__APPLE__)
#error "The ANGLE runtime bridge currently requires macOS."
#endif
#include <TargetConditionals.h>
#if !TARGET_OS_OSX
#error "The ANGLE runtime bridge currently requires macOS."
#endif

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <IOSurface/IOSurface.h>
#include "angle.h"
#include "angle-loader/egl_loader.h"
#include "angle-loader/gles_loader.h"
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <limits>
#include <cstring>
#include <dlfcn.h>
#include <filesystem>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {
thread_local char last_error[512] = {};
std::mutex lease_mutex;
bool failed_initialization_cleanup = false;

void set_error(const char *message) noexcept {
    std::snprintf(last_error, sizeof(last_error), "%s", message);
}
void require(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}
void require_egl(EGLBoolean condition, const char *operation) {
    if (condition == EGL_TRUE) return;
    char message[256];
    std::snprintf(message, sizeof(message), "%s (EGL error 0x%04x)", operation,
                  static_cast<unsigned>(eglGetError()));
    throw std::runtime_error(message);
}
bool has_extension(const char *list, const char *name) noexcept {
    if (!list) return false;
    const size_t length = std::strlen(name);
    const char *match = list;
    while ((match = std::strstr(match, name))) {
        if ((match == list || match[-1] == ' ') &&
            (match[length] == '\0' || match[length] == ' ')) return true;
        match += length;
    }
    return false;
}
GenericProc KHRONOS_APIENTRY no_proc(const char *) { return nullptr; }

struct DisplayState {
    std::string directory;
    const std::thread::id thread = std::this_thread::get_id();
    void *egl_module = nullptr;
    void *gles_module = nullptr;
    LoadProc get_proc = nullptr;
    EGLDisplay display = EGL_NO_DISPLAY;
    bool loaders_installed = false;
    bool initialized = false;
    bool thread_attached = false;

    explicit DisplayState(std::string path) : directory(std::move(path)) {}
    ~DisplayState() noexcept {
        // Public destruction closes the last owner before deleting its handle.
        // This fallback only handles a partially constructed display.
        try { close(); }
        catch (...) {
            failed_initialization_cleanup = true;
            set_error("ANGLE initialization cleanup failed; libraries retained and new leases disabled");
            return;
        }
        if (loaders_installed) {
            LoadGLES(no_proc);
            LoadEGL(no_proc);
        }
        if (egl_module) dlclose(egl_module);
        if (gles_module) dlclose(gles_module);
    }
    void check_thread() const {
        require(thread == std::this_thread::get_id(), "ANGLE call rejected on a non-owner thread");
    }
    void check_ready() const {
        check_thread();
        require(initialized, "ANGLE display teardown is incomplete; retry destruction");
    }
    void close() {
        if (initialized) {
            require_egl(eglTerminate(display), "ANGLE display termination failed");
            initialized = false;
        }
        if (thread_attached) {
            require_egl(eglReleaseThread(), "ANGLE thread release failed");
            thread_attached = false;
        }
    }
    void check_dimensions(EGLConfig config, unsigned width, unsigned height) const {
        const EGLint max_width = config_value(config, EGL_MAX_PBUFFER_WIDTH);
        const EGLint max_height = config_value(config, EGL_MAX_PBUFFER_HEIGHT);
        const EGLint max_pixels = config_value(config, EGL_MAX_PBUFFER_PIXELS);
        require(max_width > 0 && max_height > 0 && max_pixels > 0, "ANGLE reports invalid pbuffer limits");
        require(width > 0 && height > 0 && width <= 16384 && height <= 16384,
                "ANGLE dimensions must be in 1..16384");
        require(width <= static_cast<unsigned>(max_width) &&
                    height <= static_cast<unsigned>(max_height) &&
                    static_cast<uint64_t>(width) * height <= static_cast<uint64_t>(max_pixels),
                "ANGLE dimensions exceed the selected pbuffer config limits");
    }
    EGLint config_value(EGLConfig config, EGLint attribute) const {
        EGLint value = 0;
        require_egl(eglGetConfigAttrib(display, config, attribute, &value), "ANGLE config query failed");
        return value;
    }
    void initialize() {
        gles_module = dlopen((directory + "/libGLESv2.dylib").c_str(), RTLD_NOW | RTLD_LOCAL);
        require(gles_module, "ANGLE GLES library load failed");
        egl_module = dlopen((directory + "/libEGL.dylib").c_str(), RTLD_NOW | RTLD_LOCAL);
        require(egl_module, "ANGLE EGL library load failed");
        get_proc = reinterpret_cast<LoadProc>(dlsym(egl_module, "eglGetProcAddress"));
        require(get_proc, "ANGLE eglGetProcAddress is missing");
        LoadEGL(get_proc);
        LoadGLES(get_proc);
        loaders_installed = true;
        require(eglGetPlatformDisplayEXT && eglInitialize && eglTerminate && eglReleaseThread &&
                    eglQueryString && eglBindAPI && eglChooseConfig && eglGetConfigAttrib &&
                    eglCreateContext && eglDestroyContext && eglQueryContext &&
                    eglCreatePbufferSurface && eglDestroySurface && eglQuerySurface &&
                    eglMakeCurrent && eglGetCurrentContext && eglGetCurrentDisplay &&
                    eglGetCurrentSurface && eglGetError && glGetString && glViewport && glScissor &&
                    glGetIntegerv && glGetBooleanv && glIsEnabled && glBindFramebuffer &&
                    glDrawBuffers && glColorMask && glDepthMask && glStencilMaskSeparate &&
                    glEnable && glDisable && glClearBufferfv && glClearBufferiv,
                "ANGLE is missing required EGL/GLES entry points");
        thread_attached = true;
        const EGLint platform[] = {
            EGL_PLATFORM_ANGLE_TYPE_ANGLE, EGL_PLATFORM_ANGLE_TYPE_METAL_ANGLE, EGL_NONE,
        };
        display = eglGetPlatformDisplayEXT(EGL_PLATFORM_ANGLE_ANGLE, nullptr, platform);
        require(display != EGL_NO_DISPLAY, "ANGLE Metal display selection failed");
        require_egl(eglInitialize(display, nullptr, nullptr), "ANGLE Metal display initialization failed");
        initialized = true;
        const char *extensions = eglQueryString(display, EGL_EXTENSIONS);
        // ANGLE validates WebGL buffer bounds on Metal without EXT native robust
        // access. Resource initialization remains required on context and surface.
        for (const char *required : {"EGL_ANGLE_create_context_webgl_compatibility",
                                     "EGL_ANGLE_robust_resource_initialization"}) {
            if (!has_extension(extensions, required)) {
                throw std::runtime_error(std::string("ANGLE required extension unavailable: ") + required);
            }
        }
        require_egl(eglBindAPI(EGL_OPENGL_ES_API), "ANGLE OpenGL ES API binding failed");
    }
    EGLConfig select_config(bool depth, bool stencil) const {
        const EGLint attributes[] = {
            EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
            EGL_COLOR_BUFFER_TYPE, EGL_RGB_BUFFER, EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8,
            EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_DEPTH_SIZE, depth ? 24 : 0,
            EGL_STENCIL_SIZE, stencil ? 8 : 0, EGL_SAMPLE_BUFFERS, 0, EGL_NONE,
        };
        EGLint count = 0;
        require_egl(eglChooseConfig(display, attributes, nullptr, 0, &count), "ANGLE ES3 config enumeration failed");
        require(count > 0, "ANGLE ES3 pbuffer config unavailable");
        std::vector<EGLConfig> configs(count);
        require_egl(eglChooseConfig(display, attributes, configs.data(), count, &count), "ANGLE ES3 config selection failed");
        // EGL size requests are minima, including zero. Explicitly exclude omitted
        // buffers so GL blending/depth/stencil semantics match the WebGL request.
        for (EGLint i = 0; i < count; ++i) {
            const EGLConfig config = configs[i];
            if (config_value(config, EGL_RED_SIZE) == 8 && config_value(config, EGL_GREEN_SIZE) == 8 &&
                config_value(config, EGL_BLUE_SIZE) == 8 && config_value(config, EGL_ALPHA_SIZE) == 8 &&
                (depth ? config_value(config, EGL_DEPTH_SIZE) >= 24 : config_value(config, EGL_DEPTH_SIZE) == 0) &&
                (stencil ? config_value(config, EGL_STENCIL_SIZE) >= 8 : config_value(config, EGL_STENCIL_SIZE) == 0) &&
                config_value(config, EGL_SAMPLE_BUFFERS) == 0) return config;
        }
        throw std::runtime_error("ANGLE pbuffer config for requested alpha/depth/stencil attributes unavailable");
    }
};

// Every strong-reference release and loader-table mutation happens under this
// lease's mutex, so final teardown cannot race a new library generation.
std::weak_ptr<DisplayState> active_display;

template <typename T, typename Action>
T protected_call(T failure, Action action) noexcept {
    last_error[0] = '\0';
    @try {
        @autoreleasepool {
            try {
                std::lock_guard<std::mutex> lock(lease_mutex);
                return action();
            } catch (const std::exception &error) {
                set_error(error.what());
            } catch (...) {
                set_error("Unknown C++ exception in ANGLE bridge");
            }
        }
    } @catch (...) {
        set_error("Objective-C exception in ANGLE bridge");
    }
    return failure;
}

struct CurrentBinding {
    EGLDisplay display = eglGetCurrentDisplay();
    EGLContext context = eglGetCurrentContext();
    EGLSurface draw = eglGetCurrentSurface(EGL_DRAW);
    EGLSurface read = eglGetCurrentSurface(EGL_READ);

    bool restore(EGLDisplay fallback) const noexcept {
        return eglMakeCurrent(display == EGL_NO_DISPLAY ? fallback : display,
                              draw, read, context) == EGL_TRUE;
    }
};

struct PendingSurface {
    DisplayState &owner;
    EGLSurface surface = EGL_NO_SURFACE;
    PendingSurface(DisplayState &state, EGLConfig config, unsigned width, unsigned height, bool alpha) : owner(state) {
        const EGLint attributes[] = {
            EGL_WIDTH, static_cast<EGLint>(width), EGL_HEIGHT, static_cast<EGLint>(height),
            EGL_LARGEST_PBUFFER, EGL_FALSE,
            EGL_ROBUST_RESOURCE_INITIALIZATION_ANGLE, EGL_TRUE, EGL_NONE,
        };
        if (alpha) {
            surface = eglCreatePbufferSurface(owner.display, config, attributes);
        } else {
            require(eglCreatePbufferFromClientBuffer &&
                        has_extension(eglQueryString(owner.display, EGL_EXTENSIONS), "EGL_ANGLE_iosurface_client_buffer"),
                    "ANGLE RGB IOSurface pbuffer support unavailable");
            // Dimensions were checked against bounded EGL limits before this allocation.
            // ANGLE retains the IOSurface for the EGL surface lifetime. There is no
            // CPU lock, mapping or pixel copy; ANGLE initializes RGBX alpha on the GPU.
            const size_t row_bytes = IOSurfaceAlignProperty(kIOSurfaceBytesPerRow, static_cast<size_t>(width) * 4);
            require(row_bytes >= static_cast<size_t>(width) * 4 &&
                        row_bytes <= std::numeric_limits<size_t>::max() / height,
                    "ANGLE RGB IOSurface allocation size overflow");
            NSDictionary *properties = @{
                (id)kIOSurfaceWidth: @(width), (id)kIOSurfaceHeight: @(height),
                (id)kIOSurfaceBytesPerElement: @4, (id)kIOSurfaceBytesPerRow: @(row_bytes),
                (id)kIOSurfaceAllocSize: @(row_bytes * height), (id)kIOSurfacePixelFormat: @((uint32_t)'RGBA'),
            };
            IOSurfaceRef storage = IOSurfaceCreate((__bridge CFDictionaryRef)properties);
            require(storage != nullptr, "ANGLE RGB IOSurface allocation failed");
            const EGLint rgb_attributes[] = {
                EGL_WIDTH, static_cast<EGLint>(width), EGL_HEIGHT, static_cast<EGLint>(height),
                EGL_IOSURFACE_PLANE_ANGLE, 0, EGL_TEXTURE_TARGET, EGL_TEXTURE_2D,
                EGL_TEXTURE_INTERNAL_FORMAT_ANGLE, GL_RGB, EGL_TEXTURE_FORMAT, EGL_TEXTURE_RGBA,
                EGL_TEXTURE_TYPE_ANGLE, GL_UNSIGNED_BYTE, EGL_NONE,
            };
            surface = eglCreatePbufferFromClientBuffer(owner.display, EGL_IOSURFACE_ANGLE,
                reinterpret_cast<EGLClientBuffer>(storage), config, rgb_attributes);
            CFRelease(storage);
        }
        require_egl(surface != EGL_NO_SURFACE ? EGL_TRUE : EGL_FALSE, "ANGLE pbuffer creation failed");
    }
    ~PendingSurface() noexcept {
        if (surface != EGL_NO_SURFACE && eglDestroySurface(owner.display, surface) != EGL_TRUE)
            set_error("ANGLE temporary pbuffer cleanup failed");
    }
    void validate(unsigned width, unsigned height, bool alpha) const {
        EGLint actual_width = 0, actual_height = 0, initialized = 0;
        require_egl(eglQuerySurface(owner.display, surface, EGL_WIDTH, &actual_width), "ANGLE pbuffer width query failed");
        require_egl(eglQuerySurface(owner.display, surface, EGL_HEIGHT, &actual_height), "ANGLE pbuffer height query failed");
        // Client-buffer surfaces reject the robust-init attribute. Their fresh
        // attachments are explicitly GPU-cleared before any application access.
        require_egl(eglQuerySurface(owner.display, surface, EGL_ROBUST_RESOURCE_INITIALIZATION_ANGLE, &initialized),
                    "ANGLE pbuffer initialization query failed");
        require(actual_width == static_cast<EGLint>(width) && actual_height == static_cast<EGLint>(height) &&
                    (!alpha || initialized == EGL_TRUE), "ANGLE pbuffer size or robust initialization differs from the request");
    }
    EGLSurface release() noexcept { EGLSurface value = surface; surface = EGL_NO_SURFACE; return value; }
};

struct PbufferClearState {
    GLint read = 0, draw = 0, default_draw = 0;
    GLboolean color_mask[4] = {}, scissor = GL_FALSE, discard = GL_FALSE;
    PbufferClearState() {
        glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &read);
        glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw);
        glGetBooleanv(GL_COLOR_WRITEMASK, color_mask);
        scissor = glIsEnabled(GL_SCISSOR_TEST);
        discard = glIsEnabled(GL_RASTERIZER_DISCARD);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        glGetIntegerv(GL_DRAW_BUFFER0, &default_draw);
    }
    ~PbufferClearState() noexcept {
        // Draw-buffer selection belongs to the default framebuffer, not the
        // application's saved draw FBO, which may itself be incomplete.
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
        const GLenum buffer = static_cast<GLenum>(default_draw);
        glDrawBuffers(1, &buffer);
        glBindFramebuffer(GL_READ_FRAMEBUFFER, static_cast<GLuint>(read));
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, static_cast<GLuint>(draw));
        glColorMask(color_mask[0], color_mask[1], color_mask[2], color_mask[3]);
        if (scissor) glEnable(GL_SCISSOR_TEST); else glDisable(GL_SCISSOR_TEST);
        if (discard) glEnable(GL_RASTERIZER_DISCARD); else glDisable(GL_RASTERIZER_DISCARD);
    }
};

void initialize_pbuffer_attachments() {
    // ANGLE ac6cda4cbd71 reads a null lazy Metal color attachment when the
    // first operation on a robust pbuffer is a blit. Clear only newly allocated
    // storage through the draw path before exposing it; never clear on publish.
    const PbufferClearState restore;
    const GLenum buffer = GL_BACK;
    glDrawBuffers(1, &buffer);
    glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    glDisable(GL_SCISSOR_TEST);
    glDisable(GL_RASTERIZER_DISCARD);
    const GLfloat zero[4] = {};
    glClearBufferfv(GL_COLOR, 0, zero);
    // IOSurface client buffers cannot request EGL robust initialization. Clear
    // depth/stencil too, preserving application write masks across resize.
    GLboolean depth_mask = GL_TRUE;
    GLint front_mask = 0, back_mask = 0, depth_bits = 0, stencil_bits = 0;
    glGetBooleanv(GL_DEPTH_WRITEMASK, &depth_mask);
    glGetIntegerv(GL_STENCIL_WRITEMASK, &front_mask);
    glGetIntegerv(GL_STENCIL_BACK_WRITEMASK, &back_mask);
    glGetIntegerv(GL_DEPTH_BITS, &depth_bits);
    glGetIntegerv(GL_STENCIL_BITS, &stencil_bits);
    glDepthMask(GL_TRUE);
    glStencilMaskSeparate(GL_FRONT_AND_BACK, ~0u);
    const GLfloat depth = 1.0f;
    const GLint stencil = 0;
    if (depth_bits) glClearBufferfv(GL_DEPTH, 0, &depth);
    if (stencil_bits) glClearBufferiv(GL_STENCIL, 0, &stencil);
    glDepthMask(depth_mask);
    glStencilMaskSeparate(GL_FRONT, static_cast<GLuint>(front_mask));
    glStencilMaskSeparate(GL_BACK, static_cast<GLuint>(back_mask));
}
} // namespace

struct AngleDisplay { std::shared_ptr<DisplayState> owner; };
struct AngleContext {
    std::shared_ptr<DisplayState> owner;
    EGLConfig config = nullptr;
    EGLContext context = EGL_NO_CONTEXT;
    EGLSurface surface = EGL_NO_SURFACE;
    unsigned width = 0, height = 0;
    unsigned live_snapshots = 0;
    bool alpha = true;

    void check() const {
        owner->check_ready();
        require(context != EGL_NO_CONTEXT && surface != EGL_NO_SURFACE,
                "ANGLE context teardown is incomplete; retry destruction");
    }
    void close() {
        require(live_snapshots == 0, "ANGLE context has live snapshots; retire them before destruction");
        if (context != EGL_NO_CONTEXT && eglGetCurrentContext() == context)
            require_egl(eglMakeCurrent(owner->display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT),
                        "ANGLE current context release failed");
        if (context != EGL_NO_CONTEXT) {
            require_egl(eglDestroyContext(owner->display, context), "ANGLE context destruction failed");
            context = EGL_NO_CONTEXT;
        }
        if (surface != EGL_NO_SURFACE) {
            require_egl(eglDestroySurface(owner->display, surface), "ANGLE pbuffer destruction failed");
            surface = EGL_NO_SURFACE;
        }
    }
};

namespace {
constexpr uint64_t snapshot_timeout_ns = 15'000'000'000ULL;

struct CommandCompletion {
    std::mutex mutex;
    std::condition_variable changed;
    bool completed = false;
};

std::shared_ptr<CommandCompletion> observe_completion(id<MTLCommandBuffer> command) {
    auto completion = std::make_shared<CommandCompletion>();
    [command addCompletedHandler:^(id<MTLCommandBuffer>) {
        {
            std::lock_guard<std::mutex> lock(completion->mutex);
            completion->completed = true;
        }
        completion->changed.notify_all();
    }];
    return completion;
}

void wait_command(id<MTLCommandBuffer> command,
                  const std::shared_ptr<CommandCompletion> &completion,
                  uint64_t timeout_ns) {
    require(command && completion, "Metal completion ownership is missing");
    std::unique_lock<std::mutex> lock(completion->mutex);
    require(completion->changed.wait_for(lock, std::chrono::nanoseconds(timeout_ns),
                                        [&] { return completion->completed; }),
            "Metal snapshot completion timed out; resources retained");
    require(command.status == MTLCommandBufferStatusCompleted,
            "Metal snapshot command failed; resources retained");
}

struct SnapshotCurrent {
    AngleContext &parent;
    const CurrentBinding previous;
    bool restored = false;
    explicit SnapshotCurrent(AngleContext &context) : parent(context) {
        require_egl(eglMakeCurrent(parent.owner->display, parent.surface,
                                  parent.surface, parent.context),
                    "ANGLE snapshot make-current failed");
    }
    void restore() {
        require(previous.restore(parent.owner->display),
                "ANGLE snapshot could not restore the previous current context");
        restored = true;
    }
    ~SnapshotCurrent() noexcept {
        if (!restored && !previous.restore(parent.owner->display))
            set_error("ANGLE snapshot error cleanup could not restore the previous current context");
    }
};

struct SnapshotGlState {
    GLint read = 0, draw = 0, texture = 0, default_read = 0;
    GLboolean scissor = GL_FALSE;
    SnapshotGlState() {
        glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &read);
        glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &draw);
        glGetIntegerv(GL_TEXTURE_BINDING_2D, &texture);
        scissor = glIsEnabled(GL_SCISSOR_TEST);
        glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
        glGetIntegerv(GL_READ_BUFFER, &default_read);
    }
    ~SnapshotGlState() noexcept {
        // READ_BUFFER belongs to its framebuffer. Restore the default's value
        // before restoring the application's potentially different read FBO.
        glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
        glReadBuffer(static_cast<GLenum>(default_read));
        glBindFramebuffer(GL_READ_FRAMEBUFFER, static_cast<GLuint>(read));
        glBindFramebuffer(GL_DRAW_FRAMEBUFFER, static_cast<GLuint>(draw));
        glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(texture));
        if (scissor) glEnable(GL_SCISSOR_TEST); else glDisable(GL_SCISSOR_TEST);
    }
};
} // namespace

struct AngleSnapshot {
    enum class Phase { Ready, Published, Waiting, Released };
    AngleContext *parent;
    id<MTLDevice> device = nil;
    id<MTLTexture> texture = nil;
    id<MTLSharedEvent> event = nil;
    id<MTLCommandQueue> consumer_queue = nil;
    id<MTLCommandBuffer> last_signal = nil;
    std::shared_ptr<CommandCompletion> last_completion;
    id<MTLCommandQueue> initialization_queue = nil;
    id<MTLCommandBuffer> initialization = nil;
    std::shared_ptr<CommandCompletion> initialization_completion;
    EGLImageKHR image = EGL_NO_IMAGE_KHR;
    EGLSync producer_sync = EGL_NO_SYNC, auxiliary_sync = EGL_NO_SYNC;
    GLuint gl_texture = 0, framebuffer = 0;
    uint64_t next_token = 1, token = 0;
    Phase phase = Phase::Ready;
    bool initialized = false, poisoned = false, unknown_work = false;

    explicit AngleSnapshot(AngleContext *context) : parent(context) {
        require(parent->live_snapshots < std::numeric_limits<unsigned>::max(),
                "ANGLE snapshot count exhausted");
        ++parent->live_snapshots;
    }
    void check() const {
        parent->check();
        require(initialized, "ANGLE snapshot initialization did not complete");
    }
    EGLSync event_sync(uint64_t value, bool wait) {
        const EGLAttrib attributes[] = {
            EGL_SYNC_METAL_SHARED_EVENT_OBJECT_ANGLE,
            reinterpret_cast<EGLAttrib>((__bridge void *)event),
            EGL_SYNC_METAL_SHARED_EVENT_SIGNAL_VALUE_LO_ANGLE,
            static_cast<EGLAttrib>(value & 0xffffffffULL),
            EGL_SYNC_METAL_SHARED_EVENT_SIGNAL_VALUE_HI_ANGLE,
            static_cast<EGLAttrib>(value >> 32),
            EGL_SYNC_CONDITION, wait ? EGL_SYNC_METAL_SHARED_EVENT_SIGNALED_ANGLE
                                    : EGL_SYNC_PRIOR_COMMANDS_COMPLETE,
            EGL_NONE,
        };
        EGLSync sync = eglCreateSync(parent->owner->display,
                                     EGL_SYNC_METAL_SHARED_EVENT_ANGLE, attributes);
        require(sync != EGL_NO_SYNC, "ANGLE snapshot event creation failed");
        return sync;
    }
    void destroy_sync(EGLSync &sync) {
        if (sync == EGL_NO_SYNC) return;
        require_egl(eglDestroySync(parent->owner->display, sync),
                    "ANGLE snapshot sync destruction failed");
        sync = EGL_NO_SYNC;
    }
    void initialize() {
        auto &owner = *parent->owner;
        const char *extensions = eglQueryString(owner.display, EGL_EXTENSIONS);
        require(has_extension(extensions, "EGL_ANGLE_metal_texture_client_buffer") &&
                    has_extension(extensions, "EGL_ANGLE_metal_shared_event_sync"),
                "ANGLE Metal texture/shared-event extensions are unavailable");
        require(eglQueryDisplayAttribEXT && eglQueryDeviceAttribEXT && eglCreateImageKHR &&
                    eglDestroyImageKHR && eglCreateSync && eglDestroySync && eglWaitSync &&
                    eglClientWaitSync && glEGLImageTargetTexture2DOES && glBlitFramebuffer &&
                    glGetIntegerv && glIsEnabled && glReadBuffer && glDrawBuffers &&
                    glGenTextures && glBindTexture && glDeleteTextures && glGenFramebuffers &&
                    glBindFramebuffer && glDeleteFramebuffers && glFramebufferTexture2D &&
                    glCheckFramebufferStatus && glEnable && glDisable && glFlush,
                "ANGLE Metal snapshot entry points are unavailable");
        EGLAttrib egl_device = 0, metal_device = 0;
        require_egl(eglQueryDisplayAttribEXT(owner.display, EGL_DEVICE_EXT, &egl_device),
                    "ANGLE snapshot EGL device query failed");
        require_egl(eglQueryDeviceAttribEXT(reinterpret_cast<EGLDeviceEXT>(egl_device),
                                           EGL_METAL_DEVICE_ANGLE, &metal_device),
                    "ANGLE snapshot Metal device query failed");
        device = (__bridge id<MTLDevice>)(reinterpret_cast<void *>(metal_device));
        require(device != nil, "ANGLE snapshot returned no Metal device");
        MTLTextureDescriptor *descriptor = [MTLTextureDescriptor
            texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm
            width:parent->width height:parent->height mipmapped:NO];
        descriptor.storageMode = MTLStorageModePrivate;
        descriptor.hazardTrackingMode = MTLHazardTrackingModeTracked;
        descriptor.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
        texture = [device newTextureWithDescriptor:descriptor];
        event = [device newSharedEvent];
        require(texture && event, "ANGLE snapshot Metal allocation failed");
        initialization_queue = [device newCommandQueue];
        require(initialization_queue != nil, "ANGLE snapshot initialization queue allocation failed");
        initialization = [initialization_queue commandBuffer];
        require(initialization != nil, "ANGLE snapshot initialization command allocation failed");
        initialization_completion = observe_completion(initialization);
        MTLRenderPassDescriptor *pass = [MTLRenderPassDescriptor renderPassDescriptor];
        pass.colorAttachments[0].texture = texture;
        pass.colorAttachments[0].loadAction = MTLLoadActionClear;
        pass.colorAttachments[0].storeAction = MTLStoreActionStore;
        pass.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0);
        id<MTLRenderCommandEncoder> encoder = [initialization renderCommandEncoderWithDescriptor:pass];
        require(encoder != nil, "ANGLE snapshot zero-clear encoder allocation failed");
        [encoder endEncoding];
        unknown_work = true;
        [initialization commit];
        wait_command(initialization, initialization_completion, snapshot_timeout_ns);
        unknown_work = false;
        initialization = nil;
        initialization_queue = nil;
        initialization_completion.reset();

        SnapshotCurrent current(*parent);
        {
            SnapshotGlState restore;
            const char *gl_extensions = reinterpret_cast<const char *>(glGetString(GL_EXTENSIONS));
            if (!has_extension(gl_extensions, "GL_OES_EGL_image")) {
                require(glRequestExtensionANGLE && has_extension(
                            reinterpret_cast<const char *>(glGetString(GL_REQUESTABLE_EXTENSIONS_ANGLE)),
                            "GL_OES_EGL_image"), "ANGLE EGL image import is unavailable");
                glRequestExtensionANGLE("GL_OES_EGL_image");
                require(has_extension(reinterpret_cast<const char *>(glGetString(GL_EXTENSIONS)),
                                      "GL_OES_EGL_image"), "ANGLE EGL image extension request failed");
            }
            const EGLint attributes[] = {EGL_IMAGE_PRESERVED_KHR, EGL_TRUE, EGL_NONE};
            image = eglCreateImageKHR(owner.display, EGL_NO_CONTEXT, EGL_METAL_TEXTURE_ANGLE,
                                      (__bridge void *)texture, attributes);
            require(image != EGL_NO_IMAGE_KHR, "ANGLE snapshot EGL image import failed");
            glGenTextures(1, &gl_texture);
            require(gl_texture != 0, "ANGLE snapshot GL texture allocation failed");
            glBindTexture(GL_TEXTURE_2D, gl_texture);
            glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, image);
            glGenFramebuffers(1, &framebuffer);
            require(framebuffer != 0, "ANGLE snapshot framebuffer allocation failed");
            glBindFramebuffer(GL_DRAW_FRAMEBUFFER, framebuffer);
            glFramebufferTexture2D(GL_DRAW_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                                   GL_TEXTURE_2D, gl_texture, 0);
            const GLenum draw_buffer = GL_COLOR_ATTACHMENT0;
            glDrawBuffers(1, &draw_buffer);
            require(glCheckFramebufferStatus(GL_DRAW_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE,
                    "ANGLE snapshot framebuffer is incomplete");
        }
        current.restore();
        initialized = true;
    }
    uint64_t publish() {
        check();
        require(!poisoned, "ANGLE snapshot is poisoned; only drain/destruction may be retried");
        require(phase == Phase::Ready || phase == Phase::Released,
                "ANGLE snapshot frame is still leased to its consumer");
        require(next_token < std::numeric_limits<uint64_t>::max(),
                "ANGLE snapshot event values exhausted");
        require(producer_sync == EGL_NO_SYNC && auxiliary_sync == EGL_NO_SYNC,
                "ANGLE snapshot sync cleanup is incomplete");
        SnapshotCurrent current(*parent);
        poisoned = true;
        {
            SnapshotGlState restore;
            if (phase == Phase::Released) {
                auxiliary_sync = event_sync(token + 1, true);
                require_egl(eglWaitSync(parent->owner->display, auxiliary_sync, 0),
                            "ANGLE snapshot consumer GPU wait failed");
                // ANGLE ac6cda4cbd71 encodes the Metal wait before returning.
                // The snapshot independently retains its event until final drain.
                destroy_sync(auxiliary_sync);
            }
            glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
            glReadBuffer(GL_BACK);
            glBindFramebuffer(GL_DRAW_FRAMEBUFFER, framebuffer);
            glDisable(GL_SCISSOR_TEST);
            require(glCheckFramebufferStatus(GL_READ_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE &&
                        glCheckFramebufferStatus(GL_DRAW_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE,
                    "ANGLE snapshot framebuffer is no longer complete");
            unknown_work = true;
            glBlitFramebuffer(0, 0, static_cast<GLint>(parent->width), static_cast<GLint>(parent->height),
                              0, 0, static_cast<GLint>(parent->width), static_cast<GLint>(parent->height),
                              GL_COLOR_BUFFER_BIT, GL_NEAREST);
            producer_sync = event_sync(next_token, false);
            glFlush();
            token = next_token;
            next_token += 2;
            phase = Phase::Published;
            consumer_queue = nil;
            last_signal = nil;
            last_completion.reset();
            unknown_work = false;
            destroy_sync(producer_sync);
        }
        current.restore();
        poisoned = false;
        return token;
    }
    id<MTLCommandQueue> validate_queue(void *raw_queue, uint64_t value, Phase expected) {
        check();
        require(!poisoned, "ANGLE snapshot is poisoned; only drain/destruction may be retried");
        require(value != 0 && value == token && phase == expected,
                "ANGLE snapshot token or handoff phase is invalid");
        require(raw_queue != nullptr, "ANGLE snapshot consumer queue is required");
        id<MTLCommandQueue> queue = (__bridge id<MTLCommandQueue>)raw_queue;
        require(queue.device == device, "ANGLE snapshot consumer queue has a different Metal device");
        return queue;
    }
    void queue_wait(void *raw_queue, uint64_t value) {
        id<MTLCommandQueue> queue = validate_queue(raw_queue, value, Phase::Published);
        id<MTLCommandBuffer> command = [queue commandBuffer];
        require(command != nil, "ANGLE snapshot wait command allocation failed");
        [command encodeWaitForEvent:event value:token];
        consumer_queue = queue;
        poisoned = true;
        unknown_work = true;
        [command commit];
        phase = Phase::Waiting;
        unknown_work = false;
        poisoned = false;
    }
    void queue_signal(void *raw_queue, uint64_t value) {
        id<MTLCommandQueue> queue = validate_queue(raw_queue, value, Phase::Waiting);
        require(queue == consumer_queue, "ANGLE snapshot signal must use its wait queue");
        id<MTLCommandBuffer> command = [queue commandBuffer];
        require(command != nil, "ANGLE snapshot signal command allocation failed");
        auto completion = observe_completion(command);
        [command encodeSignalEvent:event value:token + 1];
        last_signal = command;
        last_completion = std::move(completion);
        poisoned = true;
        unknown_work = true;
        [command commit];
        phase = Phase::Released;
        unknown_work = false;
        poisoned = false;
    }
    void drain(uint64_t timeout_ns) {
        parent->check();
        require(timeout_ns <= snapshot_timeout_ns, "ANGLE snapshot timeout exceeds 15 seconds");
        require(!unknown_work, "ANGLE snapshot submission completion is unknown; resources retained");
        require(phase != Phase::Waiting,
                "ANGLE snapshot consumer must queue its completion signal before drain");
        if (phase == Phase::Ready) return;
        SnapshotCurrent current(*parent);
        const bool was_poisoned = poisoned;
        poisoned = true;
        if (phase == Phase::Released) {
            wait_command(last_signal, last_completion, timeout_ns);
            require(event.signaledValue >= token + 1,
                    "ANGLE snapshot consumer completed without its release event");
        } else {
            // No consumer entered the queue: cancellation needs only producer completion.
            if (auxiliary_sync == EGL_NO_SYNC) auxiliary_sync = event_sync(token, true);
            EGLint result = eglClientWaitSync(parent->owner->display, auxiliary_sync, 0, timeout_ns);
            require(result == EGL_CONDITION_SATISFIED,
                    result == EGL_TIMEOUT_EXPIRED
                        ? "ANGLE snapshot producer completion timed out; resources retained"
                        : "ANGLE snapshot producer completion failed; resources retained");
        }
        destroy_sync(producer_sync);
        destroy_sync(auxiliary_sync);
        phase = Phase::Ready;
        consumer_queue = nil;
        last_signal = nil;
        last_completion.reset();
        current.restore();
        poisoned = was_poisoned;
    }
    void close() {
        drain(snapshot_timeout_ns);
        SnapshotCurrent current(*parent);
        {
            SnapshotGlState restore;
            destroy_sync(producer_sync);
            destroy_sync(auxiliary_sync);
            if (framebuffer) { glDeleteFramebuffers(1, &framebuffer); framebuffer = 0; }
            if (gl_texture) { glDeleteTextures(1, &gl_texture); gl_texture = 0; }
            if (image != EGL_NO_IMAGE_KHR) {
                require_egl(eglDestroyImageKHR(parent->owner->display, image),
                            "ANGLE snapshot EGL image destruction failed");
                image = EGL_NO_IMAGE_KHR;
            }
        }
        current.restore();
        --parent->live_snapshots;
    }
};

extern "C" const char *angle_error() noexcept { return last_error; }

extern "C" AngleDisplay *angle_display_create(const char *library_dir) noexcept {
    return protected_call<AngleDisplay *>(nullptr, [=] {
        require(library_dir && library_dir[0], "ANGLE library directory is required");
        require(!failed_initialization_cleanup, "An earlier ANGLE initialization cleanup failed; restart the process");
        std::error_code error;
        const auto directory = std::filesystem::canonical(library_dir, error);
        require(!error && std::filesystem::is_directory(directory), "ANGLE library directory is unavailable");
        auto owner = active_display.lock();
        if (owner) {
            owner->check_ready();
            require(owner->directory == directory.string(), "A different ANGLE library directory already owns the active display");
        } else {
            owner = std::make_shared<DisplayState>(directory.string());
            owner->initialize();
            active_display = owner;
        }
        return new AngleDisplay{std::move(owner)};
    });
}

extern "C" void angle_display_destroy(AngleDisplay *display) noexcept {
    protected_call(0, [=] {
        if (display) {
            display->owner->check_thread();
            if (display->owner.use_count() == 1) display->owner->close();
            delete display;
        }
        return 1;
    });
}

extern "C" AngleContext *angle_context_create(AngleDisplay *display, unsigned width, unsigned height) noexcept {
    return angle_context_create_with_attributes(display, width, height, 1, 1, 1);
}

extern "C" AngleContext *angle_context_create_with_attributes(AngleDisplay *display, unsigned width, unsigned height,
                                                               int alpha, int depth, int stencil) noexcept {
    return protected_call<AngleContext *>(nullptr, [=] {
        require(display, "ANGLE display handle is required");
        display->owner->check_ready();
        const EGLConfig config = display->owner->select_config(depth != 0, stencil != 0);
        display->owner->check_dimensions(config, width, height);
        auto result = std::make_unique<AngleContext>();
        result->owner = display->owner;
        result->config = config;
        result->alpha = alpha != 0;
        const CurrentBinding previous;
        require_egl(eglBindAPI(EGL_OPENGL_ES_API), "ANGLE OpenGL ES API binding failed");
        const EGLint attributes[] = {
            EGL_CONTEXT_CLIENT_VERSION, 3, EGL_CONTEXT_WEBGL_COMPATIBILITY_ANGLE, EGL_TRUE,
            EGL_ROBUST_RESOURCE_INITIALIZATION_ANGLE, EGL_TRUE,
            EGL_NONE,
        };
        result->context = eglCreateContext(result->owner->display, result->config, EGL_NO_CONTEXT, attributes);
        require(result->context != EGL_NO_CONTEXT, "ANGLE robust WebGL-compatible ES3 context creation failed");
        try {
            PendingSurface surface(*result->owner, result->config, width, height, result->alpha);
            surface.validate(width, height, result->alpha);
            require_egl(eglMakeCurrent(result->owner->display, surface.surface, surface.surface, result->context),
                        "ANGLE initial make-current failed");
            const char *renderer = reinterpret_cast<const char *>(glGetString(GL_RENDERER));
            require(renderer && std::strstr(renderer, "ANGLE Metal Renderer"), "ANGLE context did not select the Metal renderer");
            EGLint version = 0, initialized = 0;
            require_egl(eglQueryContext(result->owner->display, result->context, EGL_CONTEXT_CLIENT_VERSION, &version),
                        "ANGLE context version query failed");
            require_egl(eglQueryContext(result->owner->display, result->context,
                                        EGL_ROBUST_RESOURCE_INITIALIZATION_ANGLE, &initialized),
                        "ANGLE context initialization query failed");
            require(version >= 3 && initialized == EGL_TRUE, "ANGLE context did not satisfy ES3 and initialization requirements");
            initialize_pbuffer_attachments();
            glViewport(0, 0, static_cast<GLsizei>(width), static_cast<GLsizei>(height));
            glScissor(0, 0, static_cast<GLsizei>(width), static_cast<GLsizei>(height));
            result->surface = surface.release();
            result->width = width; result->height = height;
        } catch (...) {
            const bool restored = previous.restore(result->owner->display);
            try { result->close(); }
            catch (...) {
                // Keep the native owner alive when failed EGL teardown cannot
                // establish that unloading its dispatch library is safe.
                result.release();
                throw std::runtime_error("ANGLE creation failed and native cleanup failed; owner retained");
            }
            require(restored, "ANGLE creation failed and restoring the previous current context failed");
            throw;
        }
        return result.release();
    });
}

extern "C" void angle_context_destroy(AngleContext *context) noexcept {
    protected_call(0, [=] {
        if (context) {
            context->owner->check_thread();
            context->close();
            if (context->owner.use_count() == 1) context->owner->close();
            delete context;
        }
        return 1;
    });
}

extern "C" int angle_context_make_current(AngleContext *context) noexcept {
    return protected_call(0, [=] {
        require(context, "ANGLE context handle is required");
        context->check();
        require_egl(eglMakeCurrent(context->owner->display, context->surface, context->surface, context->context),
                    "ANGLE make-current failed");
        return 1;
    });
}

extern "C" int angle_context_resize(AngleContext *context, unsigned width, unsigned height) noexcept {
    return protected_call(0, [=] {
        require(context, "ANGLE context handle is required");
        context->check();
        require(context->live_snapshots == 0, "ANGLE context has live snapshots; retire them before resize");
        context->owner->check_dimensions(context->config, width, height);
        PendingSurface replacement(*context->owner, context->config, width, height, context->alpha);
        replacement.validate(width, height, context->alpha);
        const CurrentBinding previous;
        require_egl(eglMakeCurrent(context->owner->display, replacement.surface, replacement.surface, context->context),
                    "ANGLE resized make-current failed");
        initialize_pbuffer_attachments();
        if (eglDestroySurface(context->owner->display, context->surface) != EGL_TRUE) {
            const bool restored = previous.restore(context->owner->display);
            require(restored, "ANGLE resize failed and restoring the previous current context failed");
            throw std::runtime_error("ANGLE previous pbuffer destruction failed; resize was not committed");
        }
        context->surface = replacement.release();
        context->width = width; context->height = height;
        return 1;
    });
}

extern "C" void *angle_get_proc(AngleDisplay *display, const char *name) noexcept {
    return protected_call<void *>(nullptr, [=] {
        require(display, "ANGLE display handle is required");
        display->owner->check_ready();
        require(name && name[0], "ANGLE procedure name is required");
        auto &owner = *display->owner;
        void *proc = reinterpret_cast<void *>(owner.get_proc(name));
        if (!proc) proc = dlsym(owner.gles_module, name);
        if (!proc) proc = dlsym(owner.egl_module, name);
        require(proc, "ANGLE procedure is unavailable");
        return proc;
    });
}

extern "C" AngleSnapshot *angle_snapshot_create(AngleContext *context) noexcept {
    return protected_call<AngleSnapshot *>(nullptr, [=] {
        require(context, "ANGLE snapshot parent context is required");
        context->check();
        auto *snapshot = new AngleSnapshot(context);
        try {
            @try {
                snapshot->initialize();
            } @catch (id exception) {
                (void)exception;
                // A native exception may follow a partial Metal submission.
                snapshot->unknown_work = true;
                throw std::runtime_error("Objective-C exception during snapshot creation");
            }
            return snapshot;
        } catch (...) {
            snapshot->poisoned = true;
            if (snapshot->unknown_work)
                throw std::runtime_error("ANGLE snapshot initialization completion is uncertain; snapshot and parent retained");
            try {
                if (snapshot->image != EGL_NO_IMAGE_KHR || snapshot->gl_texture || snapshot->framebuffer)
                    snapshot->close();
                else
                    --context->live_snapshots;
                delete snapshot;
            } catch (...) {
                throw std::runtime_error("ANGLE snapshot initialization cleanup failed; snapshot and parent retained");
            }
            throw;
        }
    });
}

extern "C" int angle_snapshot_destroy(AngleSnapshot *snapshot) noexcept {
    return protected_call(0, [=] {
        if (snapshot) {
            snapshot->close();
            delete snapshot;
        }
        return 1;
    });
}

extern "C" void *angle_snapshot_device(AngleSnapshot *snapshot) noexcept {
    return protected_call<void *>(nullptr, [=] {
        require(snapshot, "ANGLE snapshot handle is required");
        snapshot->check();
        return (__bridge void *)snapshot->device;
    });
}

extern "C" void *angle_snapshot_texture(AngleSnapshot *snapshot) noexcept {
    return protected_call<void *>(nullptr, [=] {
        require(snapshot, "ANGLE snapshot handle is required");
        snapshot->check();
        return (__bridge void *)snapshot->texture;
    });
}

extern "C" uint64_t angle_snapshot_publish(AngleSnapshot *snapshot) noexcept {
    return protected_call<uint64_t>(0, [=] {
        require(snapshot, "ANGLE snapshot handle is required");
        return snapshot->publish();
    });
}

extern "C" int angle_snapshot_queue_wait(AngleSnapshot *snapshot, void *queue,
                                         uint64_t producer_token) noexcept {
    return protected_call(0, [=] {
        require(snapshot, "ANGLE snapshot handle is required");
        snapshot->queue_wait(queue, producer_token);
        return 1;
    });
}

extern "C" int angle_snapshot_queue_signal(AngleSnapshot *snapshot, void *queue,
                                           uint64_t producer_token) noexcept {
    return protected_call(0, [=] {
        require(snapshot, "ANGLE snapshot handle is required");
        snapshot->queue_signal(queue, producer_token);
        return 1;
    });
}

extern "C" int angle_snapshot_drain(AngleSnapshot *snapshot, uint64_t timeout_ns) noexcept {
    return protected_call(0, [=] {
        require(snapshot, "ANGLE snapshot handle is required");
        snapshot->drain(timeout_ns);
        return 1;
    });
}
