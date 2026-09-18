use std::{
    future::Future,
    path::Path,
    pin::Pin,
    task::{Context, Poll, Waker},
};

use deno_core::{error::CoreError, v8};

use crate::{FrameOutcome, Runtime, RuntimeError};

type ModuleEvaluation = Pin<Box<dyn Future<Output = Result<(), CoreError>>>>;

/// An evaluated application driven exclusively by the caller's native event loop.
/// The caller polls after wakes, dispatches frames on redraw, then presents.
pub struct InteractiveRuntime {
    // Evaluation may retain isolate handles; drop it before the runtime.
    evaluation: Option<ModuleEvaluation>,
    pub(crate) runtime: Runtime,
}

impl Runtime {
    pub async fn into_interactive(
        mut self,
        path: &Path,
    ) -> Result<InteractiveRuntime, RuntimeError> {
        if self.surface.is_none() {
            return Err(RuntimeError::ExecutionMode(
                "interactive execution requires a window",
            ));
        }
        let id = self.load_module(path).await?;
        let evaluation = Some(Box::pin(self.js.mod_evaluate(id)) as Pin<Box<_>>);
        Ok(InteractiveRuntime {
            evaluation,
            runtime: self,
        })
    }

    pub(crate) fn resize_window(
        &mut self,
        width: u32,
        height: u32,
        scale: f64,
    ) -> Result<(), RuntimeError> {
        let callback = self
            .surface
            .as_ref()
            .and_then(|surface| surface.borrow().resize.clone());
        if let Some(callback) = callback {
            self.call_sync(&callback, &[width.into(), height.into(), scale], "resize")?;
        }
        Ok(())
    }

    fn call_sync(
        &mut self,
        callback: &v8::Global<v8::Function>,
        numbers: &[f64],
        phase: &'static str,
    ) -> Result<(), RuntimeError> {
        let args: Vec<_> = {
            deno_core::scope!(scope, self.js);
            numbers
                .iter()
                .map(|number| {
                    let local: v8::Local<v8::Value> = v8::Number::new(scope, *number).into();
                    v8::Global::new(scope, local)
                })
                .collect()
        };
        self.call_values_sync(callback, &args, phase)
    }

    pub(crate) fn call_values_sync(
        &mut self,
        callback: &v8::Global<v8::Function>,
        args: &[v8::Global<v8::Value>],
        phase: &'static str,
    ) -> Result<(), RuntimeError> {
        let call = self.js.call_with_args(callback, args);
        let mut call = std::pin::pin!(call);
        match call.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(Ok(_)) => Ok(()),
            Poll::Ready(Err(error)) => Err(self.javascript_error(phase, error)),
            Poll::Pending => Err(RuntimeError::JavaScript {
                phase,
                message: "internal host callback unexpectedly returned a promise".into(),
            }),
        }
    }
}

impl InteractiveRuntime {
    /// Poll with an OS-event-loop waker and an active async reactor. This never
    /// waits for the application to stop scheduling timers or animation frames.
    pub fn poll(&mut self, cx: &mut Context<'_>) -> Result<(), RuntimeError> {
        if self.runtime.interrupt.is_requested() {
            return Err(RuntimeError::Cancelled);
        }
        if let Poll::Ready(Err(error)) = self.runtime.js.poll_event_loop(cx, Default::default()) {
            return Err(self.runtime.javascript_error("event loop", error));
        }
        if let Some(evaluation) = &mut self.evaluation
            && let Poll::Ready(result) = evaluation.as_mut().poll(cx)
        {
            self.evaluation = None;
            result.map_err(|error| self.runtime.javascript_error("module evaluation", error))?;
        }
        Ok(())
    }

    pub fn dispatch_frame(&mut self) -> Result<(), RuntimeError> {
        let callback = self
            .runtime
            .surface
            .as_ref()
            .and_then(|surface| surface.borrow().dispatch_frame.clone());
        if let Some(callback) = callback {
            self.runtime.call_sync(&callback, &[], "animation frame")?;
        }
        Ok(())
    }

    pub fn needs_redraw(&mut self) -> bool {
        deno_core::scope!(scope, self.runtime.js);
        self.runtime
            .surface
            .as_ref()
            .is_some_and(|surface| surface.borrow().needs_redraw(scope))
    }

    /// A completed frame awaiting a drawable must be presented without replaying JS.
    pub fn has_deferred_frame(&self) -> bool {
        self.runtime
            .surface
            .as_ref()
            .is_some_and(|surface| surface.borrow().has_deferred_frame())
    }

    pub fn present(&mut self) -> Result<FrameOutcome, RuntimeError> {
        deno_core::scope!(scope, self.runtime.js);
        if let Some(surface) = &self.runtime.surface {
            return surface.borrow_mut().present(scope);
        }
        Ok(FrameOutcome::NoFrame)
    }

    pub fn resize(&mut self, width: u32, height: u32, scale: f64) -> Result<(), RuntimeError> {
        self.runtime.resize_window(width, height, scale)
    }

    pub fn presented_frames(&self) -> u64 {
        self.runtime
            .surface
            .as_ref()
            .map_or(0, |surface| surface.borrow().presented_frames)
    }

    /// Abandon an acquired image before hiding, resizing, or closing the window.
    pub fn discard_frame(&mut self) -> Result<(), RuntimeError> {
        deno_core::scope!(scope, self.runtime.js);
        if let Some(surface) = &self.runtime.surface {
            surface
                .borrow_mut()
                .discard(scope)
                .map_err(|error| RuntimeError::Surface(error.to_string()))?;
        }
        Ok(())
    }
}
