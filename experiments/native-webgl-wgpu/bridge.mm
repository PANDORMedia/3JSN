#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <dlfcn.h>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#include "angle-loader/egl_loader.h"
#include "angle-loader/gles_loader.h"

static thread_local std::string lastError;
static void require(bool ok, const std::string &message) { if (!ok) throw std::runtime_error(message); }
static bool has(const char *list, const char *name) {
    return (std::string(" ") + (list ? list : "") + " ").find(std::string(" ") + name + " ") != std::string::npos;
}
struct Bridge {
    EGLDisplay display = EGL_NO_DISPLAY;
    EGLContext context = EGL_NO_CONTEXT;
    EGLSurface surface = EGL_NO_SURFACE;
    EGLImageKHR image = EGL_NO_IMAGE_KHR;
    GLuint texture = 0, framebuffer = 0, program = 0;
    GLint color = -1;
    unsigned width = 0, height = 0;
    id<MTLDevice> device;
    id<MTLTexture> producer;
    id<MTLSharedEvent> event;
    id<MTLCommandBuffer> lastSignal;
    std::vector<EGLSync> syncs;
    std::string renderer, version;
    ~Bridge() {
        if (lastSignal) [lastSignal waitUntilCompleted];
        if (context != EGL_NO_CONTEXT) {
            eglMakeCurrent(display, surface, surface, context);
            glDeleteProgram(program);
            glDeleteFramebuffers(1, &framebuffer);
            glDeleteTextures(1, &texture);
            for (EGLSync sync : syncs) eglDestroySync(display, sync);
            if (image != EGL_NO_IMAGE_KHR) eglDestroyImageKHR(display, image);
            eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
            eglDestroyContext(display, context);
        }
        if (surface != EGL_NO_SURFACE) eglDestroySurface(display, surface);
        if (display != EGL_NO_DISPLAY) eglTerminate(display);
    }
};
static EGLSync eventSync(Bridge *b, uint64_t value, bool wait) {
    const EGLAttrib attributes[] = {
        EGL_SYNC_METAL_SHARED_EVENT_OBJECT_ANGLE, (EGLAttrib)(__bridge void *)b->event,
        EGL_SYNC_METAL_SHARED_EVENT_SIGNAL_VALUE_LO_ANGLE, (EGLAttrib)(value & 0xffffffff),
        EGL_SYNC_METAL_SHARED_EVENT_SIGNAL_VALUE_HI_ANGLE, (EGLAttrib)(value >> 32),
        EGL_SYNC_CONDITION, wait ? EGL_SYNC_METAL_SHARED_EVENT_SIGNALED_ANGLE : EGL_SYNC_PRIOR_COMMANDS_COMPLETE,
        EGL_NONE
    };
    EGLSync sync = eglCreateSync(b->display, EGL_SYNC_METAL_SHARED_EVENT_ANGLE, attributes);
    require(sync != EGL_NO_SYNC, "EGL Metal event sync failed");
    b->syncs.push_back(sync);
    return sync;
}
static GLuint compile(GLenum type, const char *source) {
    GLuint shader = glCreateShader(type);
    glShaderSource(shader, 1, &source, nullptr);
    glCompileShader(shader);
    GLint compiled = 0;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &compiled);
    require(compiled, "GLSL compile failed");
    return shader;
}
extern "C" const char *bridge_error() { return lastError.c_str(); }
extern "C" Bridge *bridge_create(const char *libraryDirectory, unsigned width, unsigned height) {
    @autoreleasepool {
        try {
            static void *module = dlopen((std::string(libraryDirectory) + "/libEGL.dylib").c_str(), RTLD_NOW | RTLD_LOCAL);
            require(module, "ANGLE EGL library load failed");
            auto getProc = (LoadProc)dlsym(module, "eglGetProcAddress");
            require(getProc, "eglGetProcAddress missing");
            LoadEGL(getProc); LoadGLES(getProc);
            auto b = std::make_unique<Bridge>();
            b->width = width; b->height = height;
            const EGLint platform[] = {EGL_PLATFORM_ANGLE_TYPE_ANGLE, EGL_PLATFORM_ANGLE_TYPE_METAL_ANGLE, EGL_NONE};
            b->display = eglGetPlatformDisplayEXT(EGL_PLATFORM_ANGLE_ANGLE, nullptr, platform);
            require(b->display != EGL_NO_DISPLAY && eglInitialize(b->display, nullptr, nullptr), "ANGLE Metal display failed");
            const char *extensions = eglQueryString(b->display, EGL_EXTENSIONS);
            require(has(extensions, "EGL_ANGLE_metal_texture_client_buffer") && has(extensions, "EGL_ANGLE_metal_shared_event_sync"), "Required ANGLE Metal extensions missing");
            EGLAttrib deviceHandle = 0, metalHandle = 0;
            require(eglQueryDisplayAttribEXT(b->display, EGL_DEVICE_EXT, &deviceHandle), "EGL device query failed");
            require(eglQueryDeviceAttribEXT((EGLDeviceEXT)deviceHandle, EGL_METAL_DEVICE_ANGLE, &metalHandle), "ANGLE MTLDevice query failed");
            b->device = (__bridge id<MTLDevice>)(void *)metalHandle;
            require(b->device != nil, "ANGLE returned no MTLDevice");
            const EGLint attributes[] = {EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT,EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
            EGLConfig config; EGLint count = 0;
            require(eglChooseConfig(b->display, attributes, &config, 1, &count) && count == 1, "ES3 config unavailable");
            const EGLint ctxAttributes[] = {EGL_CONTEXT_CLIENT_VERSION,3,EGL_CONTEXT_WEBGL_COMPATIBILITY_ANGLE,EGL_TRUE,EGL_ROBUST_RESOURCE_INITIALIZATION_ANGLE,EGL_TRUE,EGL_NONE};
            b->context = eglCreateContext(b->display, config, EGL_NO_CONTEXT, ctxAttributes);
            require(b->context != EGL_NO_CONTEXT, "ES3 context creation failed");
            const EGLint surfaceAttributes[] = {EGL_WIDTH,1,EGL_HEIGHT,1,EGL_NONE};
            b->surface = eglCreatePbufferSurface(b->display, config, surfaceAttributes);
            require(b->surface != EGL_NO_SURFACE && eglMakeCurrent(b->display,b->surface,b->surface,b->context), "Make-current failed");
            b->renderer = (const char *)glGetString(GL_RENDERER);
            b->version = (const char *)glGetString(GL_VERSION);
            require(b->renderer.find("ANGLE Metal Renderer") != std::string::npos, "ANGLE did not select Metal");
            if (!has((const char *)glGetString(GL_EXTENSIONS), "GL_OES_EGL_image")) {
                require(has((const char *)glGetString(GL_REQUESTABLE_EXTENSIONS_ANGLE), "GL_OES_EGL_image"), "GL image extension unavailable");
                glRequestExtensionANGLE("GL_OES_EGL_image");
            }
            MTLTextureDescriptor *desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:width height:height mipmapped:NO];
            desc.storageMode = MTLStorageModePrivate;
            desc.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
            b->producer = [b->device newTextureWithDescriptor:desc];
            b->event = [b->device newSharedEvent];
            require(b->producer && b->event, "Native texture/event allocation failed");
            const EGLint imageAttributes[] = {EGL_NONE};
            b->image = eglCreateImageKHR(b->display, EGL_NO_CONTEXT, EGL_METAL_TEXTURE_ANGLE, (__bridge void *)b->producer, imageAttributes);
            require(b->image != EGL_NO_IMAGE_KHR, "Private Metal texture import failed");
            glGenTextures(1, &b->texture); glBindTexture(GL_TEXTURE_2D, b->texture);
            glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, b->image);
            glGenFramebuffers(1, &b->framebuffer); glBindFramebuffer(GL_FRAMEBUFFER, b->framebuffer);
            glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, b->texture, 0);
            require(glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE, "Imported framebuffer incomplete");
            // wgpu's unsafe import requires initialized storage, before any consumer is created.
            glClearColor(0,0,0,0); glClear(GL_COLOR_BUFFER_BIT); glFinish();
            GLuint vertex = compile(GL_VERTEX_SHADER,"#version 300 es\nconst vec2 p[3]=vec2[3](vec2(-1,-1),vec2(3,-1),vec2(-1,3));void main(){gl_Position=vec4(p[gl_VertexID],0,1);}");
            GLuint fragment = compile(GL_FRAGMENT_SHADER,"#version 300 es\nprecision highp float;uniform vec4 color;out vec4 outputColor;void main(){outputColor=color;}");
            b->program = glCreateProgram(); glAttachShader(b->program,vertex); glAttachShader(b->program,fragment); glLinkProgram(b->program);
            glDeleteShader(vertex); glDeleteShader(fragment);
            GLint linked = 0; glGetProgramiv(b->program,GL_LINK_STATUS,&linked); require(linked,"GL program link failed");
            glUseProgram(b->program); b->color = glGetUniformLocation(b->program,"color");
            require(b->color >= 0 && glGetError() == GL_NO_ERROR, "GL setup failed");
            return b.release();
        } catch (const std::exception &error) { lastError = error.what(); return nullptr; }
    }
}
extern "C" void *bridge_device(Bridge *b) { return (__bridge void *)b->device; }
extern "C" void *bridge_texture(Bridge *b) { return (__bridge void *)b->producer; }
extern "C" const char *bridge_renderer(Bridge *b) { return b->renderer.c_str(); }
extern "C" const char *bridge_version(Bridge *b) { return b->version.c_str(); }
extern "C" int bridge_render(Bridge *b, unsigned frame) {
    @autoreleasepool {
        try {
            if (frame > 0) require(eglWaitSync(b->display,eventSync(b,frame*2,true),0),"ANGLE GPU consumer wait failed");
            glViewport(0,0,b->width,b->height);
            if(frame%2==0) glUniform4f(b->color,.25f,.5f,.75f,1); else glUniform4f(b->color,.75f,.25f,.5f,1);
            glDrawArrays(GL_TRIANGLES,0,3); require(glGetError()==GL_NO_ERROR,"ANGLE producer draw failed");
            eventSync(b,frame*2+1,false); glFlush();
            return 1;
        } catch (const std::exception &error) { lastError=error.what();return 0; }
    }
}
extern "C" int bridge_queue_event(Bridge *b, void *rawQueue, unsigned frame, bool wait) {
    @autoreleasepool {
        try {
            id<MTLCommandQueue> queue = (__bridge id<MTLCommandQueue>)rawQueue;
            require(queue.device == b->device,"wgpu queue does not use ANGLE's exact MTLDevice");
            id<MTLCommandBuffer> command = [queue commandBuffer];
            require(command != nil,"Metal handoff command allocation failed");
            if(wait) [command encodeWaitForEvent:b->event value:frame*2+1];
            else [command encodeSignalEvent:b->event value:frame*2+2];
            [command commit];
            if(!wait) b->lastSignal = command;
            return 1;
        } catch (const std::exception &error) { lastError=error.what();return 0; }
    }
}
extern "C" int bridge_finish(Bridge *b, unsigned frames) {
    @autoreleasepool {
        [b->lastSignal waitUntilCompleted];
        if(b->lastSignal.status != MTLCommandBufferStatusCompleted || b->event.signaledValue != frames*2) {
            lastError="Native consumer completion failed";return 0;
        }
        return 1;
    }
}
extern "C" void bridge_destroy(Bridge *b) { delete b; }
