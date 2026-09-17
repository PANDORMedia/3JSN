#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <dlfcn.h>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
#include "angle-loader/egl_loader.h"
#include "angle-loader/gles_loader.h"

static void require(bool condition, const std::string &message) {
    if (!condition) throw std::runtime_error(message);
}
static bool hasExtension(const char *list, const char *name) {
    std::string extensions = std::string(" ") + (list ? list : "") + " ";
    return extensions.find(std::string(" ") + name + " ") != std::string::npos;
}
static GLuint shader(GLenum type, const char *source) {
    GLuint result = glCreateShader(type);
    glShaderSource(result, 1, &source, nullptr);
    glCompileShader(result);
    GLint compiled = 0;
    glGetShaderiv(result, GL_COMPILE_STATUS, &compiled);
    char log[2048]{};
    glGetShaderInfoLog(result, sizeof(log), nullptr, log);
    require(compiled, std::string("GL shader: ") + log);
    return result;
}
static EGLSync sync(EGLDisplay display, id<MTLSharedEvent> event, uint64_t value, bool wait) {
    EGLAttrib attributes[] = {
        EGL_SYNC_METAL_SHARED_EVENT_OBJECT_ANGLE, (EGLAttrib)(__bridge void *)event,
        EGL_SYNC_METAL_SHARED_EVENT_SIGNAL_VALUE_LO_ANGLE, (EGLAttrib)(value & 0xffffffff),
        EGL_SYNC_METAL_SHARED_EVENT_SIGNAL_VALUE_HI_ANGLE, (EGLAttrib)(value >> 32),
        EGL_SYNC_CONDITION, wait ? EGL_SYNC_METAL_SHARED_EVENT_SIGNALED_ANGLE : EGL_SYNC_PRIOR_COMMANDS_COMPLETE,
        EGL_NONE
    };
    EGLSync result = eglCreateSync(display, EGL_SYNC_METAL_SHARED_EVENT_ANGLE, attributes);
    require(result != EGL_NO_SYNC, "Metal shared-event EGL sync creation failed: " + std::to_string(eglGetError()));
    return result;
}

int main(int argc, char **argv) {
    @autoreleasepool {
        try {
            require(argc == 2, "usage: probe /absolute/path/to/ANGLE/library-directory");
            std::string library = std::string(argv[1]) + "/libEGL.dylib";
            void *module = dlopen(library.c_str(), RTLD_NOW | RTLD_LOCAL);
            require(module, "Could not load ANGLE EGL library");
            auto getProc = (LoadProc)dlsym(module, "eglGetProcAddress");
            require(getProc, "eglGetProcAddress unavailable");
            LoadEGL(getProc);
            LoadGLES(getProc);
            const EGLint platformAttributes[] = { EGL_PLATFORM_ANGLE_TYPE_ANGLE, EGL_PLATFORM_ANGLE_TYPE_METAL_ANGLE, EGL_NONE };
            EGLDisplay display = eglGetPlatformDisplayEXT(EGL_PLATFORM_ANGLE_ANGLE, nullptr, platformAttributes);
            require(display != EGL_NO_DISPLAY && eglInitialize(display, nullptr, nullptr), "Metal EGL display initialization failed");
            const char *extensions = eglQueryString(display, EGL_EXTENSIONS);
            const char *required[] = { "EGL_EXT_device_query", "EGL_ANGLE_metal_texture_client_buffer", "EGL_ANGLE_metal_shared_event_sync" };
            for (const char *name : required) require(hasExtension(extensions, name) || hasExtension(eglQueryString(EGL_NO_DISPLAY, EGL_EXTENSIONS), name), std::string("Missing extension: ") + name);
            EGLAttrib deviceHandle = 0;
            require(eglQueryDisplayAttribEXT(display, EGL_DEVICE_EXT, &deviceHandle), "EGL device query failed");
            EGLDeviceEXT eglDevice = reinterpret_cast<EGLDeviceEXT>(deviceHandle);
            require(hasExtension(eglQueryDeviceStringEXT(eglDevice, EGL_EXTENSIONS), "EGL_ANGLE_device_metal"), "Metal device query extension unavailable");
            EGLAttrib metalHandle = 0;
            require(eglQueryDeviceAttribEXT(eglDevice, EGL_METAL_DEVICE_ANGLE, &metalHandle), "MTLDevice query failed");
            id<MTLDevice> device = (__bridge id<MTLDevice>)(void *)metalHandle;
            require(device != nil, "Empty MTLDevice");
            id<MTLCommandQueue> queue = [device newCommandQueue];
            require(queue != nil, "Native Metal queue creation failed");
            const EGLint configAttributes[] = { EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT, EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE };
            EGLConfig config;
            EGLint configCount = 0;
            require(eglChooseConfig(display, configAttributes, &config, 1, &configCount) && configCount == 1, "EGL ES3 config unavailable");
            const EGLint contextAttributes[] = { EGL_CONTEXT_CLIENT_VERSION, 3, EGL_CONTEXT_WEBGL_COMPATIBILITY_ANGLE, EGL_TRUE, EGL_ROBUST_RESOURCE_INITIALIZATION_ANGLE, EGL_TRUE, EGL_NONE };
            EGLContext context = eglCreateContext(display, config, EGL_NO_CONTEXT, contextAttributes);
            require(context != EGL_NO_CONTEXT, "EGL ES3 context creation failed");
            const EGLint surfaceAttributes[] = { EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE };
            EGLSurface surface = eglCreatePbufferSurface(display, config, surfaceAttributes);
            require(surface != EGL_NO_SURFACE && eglMakeCurrent(display, surface, surface, context), "EGL make-current failed");
            std::string renderer((const char *)glGetString(GL_RENDERER));
            require(renderer.find("ANGLE Metal Renderer") != std::string::npos, "Unexpected backend: " + renderer);
            std::string version((const char *)glGetString(GL_VERSION));
            if (!hasExtension((const char *)glGetString(GL_EXTENSIONS), "GL_OES_EGL_image")) {
                require(hasExtension((const char *)glGetString(GL_REQUESTABLE_EXTENSIONS_ANGLE), "GL_OES_EGL_image"), "GL_OES_EGL_image not requestable");
                glRequestExtensionANGLE("GL_OES_EGL_image");
                require(glGetError() == GL_NO_ERROR, "GL_OES_EGL_image request failed");
            }
            require(hasExtension((const char *)glGetString(GL_EXTENSIONS), "GL_OES_EGL_image"), "GL_OES_EGL_image unavailable");
            GLuint vertex = shader(GL_VERTEX_SHADER, "#version 300 es\nconst vec2 p[3]=vec2[3](vec2(-1,-1),vec2(3,-1),vec2(-1,3)); void main(){gl_Position=vec4(p[gl_VertexID],0,1);}");
            GLuint fragment = shader(GL_FRAGMENT_SHADER, "#version 300 es\nprecision highp float; uniform vec4 color; out vec4 outputColor; void main(){outputColor=color;}");
            GLuint program = glCreateProgram();
            glAttachShader(program, vertex);
            glAttachShader(program, fragment);
            glLinkProgram(program);
            GLint linked = 0;
            glGetProgramiv(program, GL_LINK_STATUS, &linked);
            require(linked, "GL program link failed");
            glUseProgram(program);
            GLint color = glGetUniformLocation(program, "color");
            require(color >= 0, "Color uniform unavailable");
            NSError *error = nil;
            NSString *metalSource = @"#include <metal_stdlib>\nusing namespace metal;\nkernel void composite(texture2d<float, access::read> input [[texture(0)]], texture2d<float, access::write> output [[texture(1)]], uint2 p [[thread_position_in_grid]]) { if (p.x >= output.get_width() || p.y >= output.get_height()) return; float4 c=input.read(p); if(p.x < output.get_width()/2) c=mix(c,float4(0,1,0,1),0.5); output.write(c,p); }";
            id<MTLLibrary> metalLibrary = [device newLibraryWithSource:metalSource options:nil error:&error];
            require(metalLibrary != nil, error ? error.localizedDescription.UTF8String : "Metal shader compile failed");
            id<MTLComputePipelineState> pipeline = [device newComputePipelineStateWithFunction:[metalLibrary newFunctionWithName:@"composite"] error:&error];
            require(pipeline != nil, error ? error.localizedDescription.UTF8String : "Metal pipeline creation failed");
            unsigned long pixelsChecked = 0;
            unsigned framesChecked = 0;
            unsigned generations = 0;
            const unsigned sizes[][2] = {{32,16},{64,32},{96,24}};
            for (unsigned repetition = 0; repetition < 4; repetition++) {
                for (const auto &size : sizes) {
                    @autoreleasepool {
                        const unsigned width = size[0], height = size[1], rowBytes = ((width * 4 + 255) / 256) * 256;
                        MTLTextureDescriptor *description = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:width height:height mipmapped:NO];
                        description.storageMode = MTLStorageModePrivate;
                        description.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
                        id<MTLTexture> producer = [device newTextureWithDescriptor:description];
                        require(producer && producer.device == device, "Producer texture ownership mismatch");
                        description.usage = MTLTextureUsageShaderWrite;
                        id<MTLTexture> composed = [device newTextureWithDescriptor:description];
                        require(composed != nil, "Composition target allocation failed");
                        const EGLint imageAttributes[] = { EGL_NONE };
                        EGLImageKHR image = eglCreateImageKHR(display, EGL_NO_CONTEXT, EGL_METAL_TEXTURE_ANGLE, (__bridge void *)producer, imageAttributes);
                        require(image != EGL_NO_IMAGE_KHR, "Metal texture import failed: " + std::to_string(eglGetError()));
                        GLuint texture = 0, framebuffer = 0;
                        glGenTextures(1, &texture);
                        glBindTexture(GL_TEXTURE_2D, texture);
                        glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, image);
                        glGenFramebuffers(1, &framebuffer);
                        glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
                        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);
                        require(glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE, "Imported framebuffer incomplete");
                        require(glGetError() == GL_NO_ERROR, "GL image setup error");
                        id<MTLSharedEvent> event = [device newSharedEvent];
                        require(event != nil, "Metal shared event unavailable");
                        NSMutableArray<id<MTLBuffer>> *readbacks = [NSMutableArray array];
                        NSMutableArray<id<MTLCommandBuffer>> *commands = [NSMutableArray array];
                        std::vector<EGLSync> syncs;
                        for (unsigned frame = 0; frame < 8; frame++) {
                            if (frame > 0) {
                                EGLSync acquire = sync(display, event, frame * 2, true);
                                syncs.push_back(acquire);
                                require(eglWaitSync(display, acquire, 0), "GL GPU wait on native consumer failed");
                            }
                            glViewport(0, 0, width, height);
                            if (frame % 2 == 0) glUniform4f(color, 0.25f, 0.5f, 0.75f, 1);
                            else glUniform4f(color, 0.75f, 0.25f, 0.5f, 1);
                            glDrawArrays(GL_TRIANGLES, 0, 3);
                            require(glGetError() == GL_NO_ERROR, "GL producer draw failed");
                            EGLSync release = sync(display, event, frame * 2 + 1, false);
                            syncs.push_back(release);
                            glFlush();
                            id<MTLCommandBuffer> command = [queue commandBuffer];
                            [command encodeWaitForEvent:event value:frame * 2 + 1];
                            id<MTLComputeCommandEncoder> compute = [command computeCommandEncoder];
                            [compute setComputePipelineState:pipeline];
                            [compute setTexture:producer atIndex:0];
                            [compute setTexture:composed atIndex:1];
                            [compute dispatchThreads:MTLSizeMake(width, height, 1) threadsPerThreadgroup:MTLSizeMake(8, 8, 1)];
                            [compute endEncoding];
                            id<MTLBuffer> readback = [device newBufferWithLength:rowBytes * height options:MTLResourceStorageModeShared];
                            require(readback != nil, "Final validation buffer allocation failed");
                            id<MTLBlitCommandEncoder> blit = [command blitCommandEncoder];
                            [blit copyFromTexture:composed sourceSlice:0 sourceLevel:0 sourceOrigin:MTLOriginMake(0,0,0) sourceSize:MTLSizeMake(width,height,1) toBuffer:readback destinationOffset:0 destinationBytesPerRow:rowBytes destinationBytesPerImage:rowBytes*height];
                            [blit endEncoding];
                            [command encodeSignalEvent:event value:frame * 2 + 2];
                            [command commit];
                            [commands addObject:command];
                            [readbacks addObject:readback];
                        }
                        // All frames are queued before the CPU observes final validation buffers.
                        [[commands lastObject] waitUntilCompleted];
                        for (unsigned frame = 0; frame < commands.count; frame++) {
                            require(commands[frame].status == MTLCommandBufferStatusCompleted, commands[frame].error ? commands[frame].error.localizedDescription.UTF8String : "Native GPU command failed");
                            const uint8_t *bytes = (const uint8_t *)readbacks[frame].contents;
                            const unsigned a[4] = {64,128,191,255}, b[4] = {191,64,128,255};
                            const unsigned *expected = frame % 2 == 0 ? a : b;
                            for (unsigned y = 0; y < height; y++) for (unsigned x = 0; x < width; x++) {
                                for (unsigned channel = 0; channel < 4; channel++) {
                                    double value = expected[channel];
                                    if (x < width / 2) value = value * 0.5 + ((channel == 1 || channel == 3) ? 127.5 : 0);
                                    int actual = bytes[y * rowBytes + x * 4 + channel];
                                    require(std::abs(actual - value) <= 1.1, "Composed pixel mismatch at generation/frame " + std::to_string(generations) + "/" + std::to_string(frame) + " pixel " + std::to_string(x) + "," + std::to_string(y) + " channel " + std::to_string(channel) + ": " + std::to_string(actual) + " expected " + std::to_string(value));
                                }
                                pixelsChecked++;
                            }
                            framesChecked++;
                        }
                        require(event.signaledValue == 16, "Incomplete GPU handshake");
                        for (EGLSync value : syncs) require(eglDestroySync(display, value), "Sync destruction failed");
                        glBindFramebuffer(GL_FRAMEBUFFER, 0);
                        glDeleteFramebuffers(1, &framebuffer);
                        glDeleteTextures(1, &texture);
                        require(eglDestroyImageKHR(display, image), "EGLImage destruction failed");
                        require(glGetError() == GL_NO_ERROR, "GL teardown error");
                        generations++;
                    }
                }
            }
            glUseProgram(0);
            glDeleteProgram(program);
            glDeleteShader(vertex);
            glDeleteShader(fragment);
            require(eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT), "Unbind failed");
            require(eglDestroySurface(display, surface) && eglDestroyContext(display, context), "EGL teardown failed");
            require(eglTerminate(display), "EGL display termination failed");
            NSDictionary *report = @{
                @"status": @"pass", @"renderer": @(renderer.c_str()), @"glesVersion": @(version.c_str()), @"device": device.name,
                @"transport": @"same-device private MTLTexture imported as EGLImage; native Metal compute composition",
                @"synchronization": @"GPU-only bidirectional MTLSharedEvent waits/signals via EGL_ANGLE_metal_shared_event_sync",
                @"producer": @"GLES3 GLSL draw through ANGLE Metal", @"consumer": @"Native Metal compute shader reads and blends into a second private texture",
                @"frames": @(framesChecked), @"textureGenerations": @(generations), @"pixelsChecked": @(pixelsChecked), @"framesQueuedBeforeCpuWait": @8,
                @"sizes": @[@[@32,@16],@[@64,@32],@[@96,@24]], @"cpuReadback": @"Final composed test pixels only; not producer-to-consumer transport",
                @"unverified": @[@"Rust/wgpu integration", @"JS WebGL binding", @"HTML compositor", @"window presentation", @"device loss", @"performance", @"Windows/Linux"]
            };
            NSData *json = [NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys error:&error];
            require(json != nil, "JSON report encoding failed");
            std::cout.write((const char *)json.bytes, json.length);
            std::cout << '\n';
            return 0;
        } catch (const std::exception &error) {
            std::cerr << "Interop probe failed: " << error.what() << '\n';
            return 1;
        }
    }
}
