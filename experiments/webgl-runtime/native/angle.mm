// SPDX-License-Identifier: MIT
#if !defined(__APPLE__)
#error "The ANGLE runtime bridge currently requires macOS."
#endif
#include <TargetConditionals.h>
#if !TARGET_OS_OSX
#error "The ANGLE runtime bridge currently requires macOS."
#endif

#import <Foundation/Foundation.h>
#include "angle.h"
#include "angle-loader/egl_loader.h"
#include "angle-loader/gles_loader.h"
#include <cstdio>
#include <cstring>
#include <dlfcn.h>
#include <filesystem>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>

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
    EGLConfig config = nullptr;
    EGLint max_width = 0, max_height = 0, max_pixels = 0;
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
    void check_dimensions(unsigned width, unsigned height) const {
        require(width > 0 && height > 0 && width <= 16384 && height <= 16384,
                "ANGLE dimensions must be in 1..16384");
        require(width <= static_cast<unsigned>(max_width) &&
                    height <= static_cast<unsigned>(max_height) &&
                    static_cast<uint64_t>(width) * height <= static_cast<uint64_t>(max_pixels),
                "ANGLE dimensions exceed the selected pbuffer config limits");
    }
    EGLint config_value(EGLint attribute) const {
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
                    eglGetCurrentSurface && eglGetError && glGetString && glViewport && glScissor,
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
        const EGLint attributes[] = {
            EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
            EGL_COLOR_BUFFER_TYPE, EGL_RGB_BUFFER, EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8,
            EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_DEPTH_SIZE, 24, EGL_STENCIL_SIZE, 8,
            EGL_SAMPLE_BUFFERS, 0, EGL_NONE,
        };
        EGLint count = 0;
        require_egl(eglChooseConfig(display, attributes, &config, 1, &count), "ANGLE ES3 config selection failed");
        require(count == 1, "ANGLE RGBA8/depth24/stencil8 ES3 pbuffer config unavailable");
        require(config_value(EGL_RED_SIZE) == 8 && config_value(EGL_GREEN_SIZE) == 8 &&
                    config_value(EGL_BLUE_SIZE) == 8 && config_value(EGL_ALPHA_SIZE) == 8 &&
                    config_value(EGL_DEPTH_SIZE) >= 24 && config_value(EGL_STENCIL_SIZE) >= 8 &&
                    config_value(EGL_SAMPLE_BUFFERS) == 0,
                "ANGLE config does not satisfy the requested framebuffer format");
        max_width = config_value(EGL_MAX_PBUFFER_WIDTH);
        max_height = config_value(EGL_MAX_PBUFFER_HEIGHT);
        max_pixels = config_value(EGL_MAX_PBUFFER_PIXELS);
        require(max_width > 0 && max_height > 0 && max_pixels > 0, "ANGLE reports invalid pbuffer limits");
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
    PendingSurface(DisplayState &state, unsigned width, unsigned height) : owner(state) {
        const EGLint attributes[] = {
            EGL_WIDTH, static_cast<EGLint>(width), EGL_HEIGHT, static_cast<EGLint>(height),
            EGL_LARGEST_PBUFFER, EGL_FALSE,
            EGL_ROBUST_RESOURCE_INITIALIZATION_ANGLE, EGL_TRUE, EGL_NONE,
        };
        surface = eglCreatePbufferSurface(owner.display, owner.config, attributes);
        require(surface != EGL_NO_SURFACE, "ANGLE pbuffer creation failed");
    }
    ~PendingSurface() noexcept {
        if (surface != EGL_NO_SURFACE && eglDestroySurface(owner.display, surface) != EGL_TRUE)
            set_error("ANGLE temporary pbuffer cleanup failed");
    }
    void validate(unsigned width, unsigned height) const {
        EGLint actual_width = 0, actual_height = 0, initialized = 0;
        require_egl(eglQuerySurface(owner.display, surface, EGL_WIDTH, &actual_width), "ANGLE pbuffer width query failed");
        require_egl(eglQuerySurface(owner.display, surface, EGL_HEIGHT, &actual_height), "ANGLE pbuffer height query failed");
        require_egl(eglQuerySurface(owner.display, surface, EGL_ROBUST_RESOURCE_INITIALIZATION_ANGLE, &initialized),
                    "ANGLE pbuffer initialization query failed");
        require(actual_width == static_cast<EGLint>(width) && actual_height == static_cast<EGLint>(height) &&
                    initialized == EGL_TRUE, "ANGLE pbuffer size or robust initialization differs from the request");
    }
    EGLSurface release() noexcept { EGLSurface value = surface; surface = EGL_NO_SURFACE; return value; }
};
} // namespace

struct AngleDisplay { std::shared_ptr<DisplayState> owner; };
struct AngleContext {
    std::shared_ptr<DisplayState> owner;
    EGLContext context = EGL_NO_CONTEXT;
    EGLSurface surface = EGL_NO_SURFACE;
    unsigned width = 0, height = 0;

    void check() const {
        owner->check_ready();
        require(context != EGL_NO_CONTEXT && surface != EGL_NO_SURFACE,
                "ANGLE context teardown is incomplete; retry destruction");
    }
    void close() {
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
    return protected_call<AngleContext *>(nullptr, [=] {
        require(display, "ANGLE display handle is required");
        display->owner->check_ready();
        display->owner->check_dimensions(width, height);
        auto result = std::make_unique<AngleContext>();
        result->owner = display->owner;
        const CurrentBinding previous;
        require_egl(eglBindAPI(EGL_OPENGL_ES_API), "ANGLE OpenGL ES API binding failed");
        const EGLint attributes[] = {
            EGL_CONTEXT_CLIENT_VERSION, 3, EGL_CONTEXT_WEBGL_COMPATIBILITY_ANGLE, EGL_TRUE,
            EGL_ROBUST_RESOURCE_INITIALIZATION_ANGLE, EGL_TRUE,
            EGL_NONE,
        };
        result->context = eglCreateContext(result->owner->display, result->owner->config, EGL_NO_CONTEXT, attributes);
        require(result->context != EGL_NO_CONTEXT, "ANGLE robust WebGL-compatible ES3 context creation failed");
        try {
            PendingSurface surface(*result->owner, width, height);
            surface.validate(width, height);
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
        context->owner->check_dimensions(width, height);
        PendingSurface replacement(*context->owner, width, height);
        replacement.validate(width, height);
        const CurrentBinding previous;
        require_egl(eglMakeCurrent(context->owner->display, replacement.surface, replacement.surface, context->context),
                    "ANGLE resized make-current failed");
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
