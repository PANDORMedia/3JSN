// SPDX-License-Identifier: MIT
#ifndef THREEJS_WEBGL_RUNTIME_ANGLE_H
#define THREEJS_WEBGL_RUNTIME_ANGLE_H

#ifdef __cplusplus
#define ANGLE_NOEXCEPT noexcept
extern "C" {
#else
#define ANGLE_NOEXCEPT
#endif

typedef struct AngleDisplay AngleDisplay;
typedef struct AngleContext AngleContext;

// One owner thread per active library/display lease. Duplicate display handles
// share that lease; contexts retain it after external display handles are freed.
// Handles and procedure pointers must not outlive their ownership. Other ANGLE
// loaders must not mutate the process-global loader tables while a lease exists.
// Returned GL procedures also require this owner thread and a current context;
// they bypass the checks performed by these C ABI entry points.
AngleDisplay *angle_display_create(const char *library_dir) ANGLE_NOEXCEPT;
void angle_display_destroy(AngleDisplay *display) ANGLE_NOEXCEPT;

// ES3, RGBA8/depth24/stencil8, WebGL validation and robust initialized storage.
// Dimensions must be in 1..16384 and satisfy the selected EGL config limits.
// Creation succeeds with this context current. Failure restores the previous
// binding unless EGL itself refuses restoration, which is reported explicitly.
AngleContext *angle_context_create(AngleDisplay *display, unsigned width,
                                   unsigned height) ANGLE_NOEXCEPT;
void angle_context_destroy(AngleContext *context) ANGLE_NOEXCEPT;
int angle_context_make_current(AngleContext *context) ANGLE_NOEXCEPT;

// Keeps the GL context/state; does not reset viewport, scissor or JS state.
// The replacement pbuffer becomes current before the previous one is destroyed.
int angle_context_resize(AngleContext *context, unsigned width,
                         unsigned height) ANGLE_NOEXCEPT;
void *angle_get_proc(AngleDisplay *display, const char *name) ANGLE_NOEXCEPT;

// All functions except this accessor replace the calling thread's last error.
// Nonempty errors indicate failure; pointer results use NULL and int results 0.
// NULL destruction is a no-op. Rejected destruction retains the handle for an
// owner-thread retry. Strings remain valid until the next API call on this thread.
const char *angle_error(void) ANGLE_NOEXCEPT;

#ifdef __cplusplus
}
#endif
#undef ANGLE_NOEXCEPT
#endif
