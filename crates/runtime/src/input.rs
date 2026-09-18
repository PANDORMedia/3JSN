//! Platform-independent input records. Coordinates are event-time CSS pixels.

use std::{cell::RefCell, rc::Rc};

use deno_core::{OpState, op2, serde::Serialize, serde_v8, v8};

use crate::{InteractiveRuntime, Runtime, RuntimeError};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(crate = "deno_core::serde", rename_all = "camelCase")]
pub struct InputModifiers {
    pub alt_key: bool,
    pub ctrl_key: bool,
    pub meta_key: bool,
    pub shift_key: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(crate = "deno_core::serde")]
pub struct InputPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(crate = "deno_core::serde", rename_all = "lowercase")]
pub enum MouseInputKind {
    Move,
    Down,
    Up,
    Leave,
}

/// Owned data only: no OS handles, isolate values or callbacks cross threads.
/// Keyboard location and mouse button/mask values use UI Events conventions.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(crate = "deno_core::serde", tag = "kind", rename_all = "camelCase")]
pub enum NativeInput {
    Key {
        pressed: bool,
        key: String,
        code: String,
        location: u8,
        repeat: bool,
        modifiers: InputModifiers,
    },
    Mouse {
        event: MouseInputKind,
        position: InputPosition,
        button: i16,
        buttons: u16,
        modifiers: InputModifiers,
    },
    Wheel {
        position: InputPosition,
        delta_x: f64,
        delta_y: f64,
        delta_mode: u8,
        buttons: u16,
        modifiers: InputModifiers,
    },
    Focus {
        focused: bool,
    },
}

pub(crate) type InputCallback = Rc<RefCell<Option<v8::Global<v8::Function>>>>;

#[op2]
pub(crate) fn op_native_bind_input(
    state: &mut OpState,
    #[scoped] callback: v8::Global<v8::Function>,
) {
    *state.borrow::<InputCallback>().borrow_mut() = Some(callback);
}

impl Runtime {
    pub(crate) fn dispatch_input(&mut self, input: &NativeInput) -> Result<(), RuntimeError> {
        let Some(callback) = self.input.borrow().clone() else {
            return Err(RuntimeError::ExecutionMode(
                "native input is not initialized",
            ));
        };
        let argument = {
            deno_core::scope!(scope, self.js);
            let value =
                serde_v8::to_v8(scope, input).map_err(|error| RuntimeError::JavaScript {
                    phase: "input serialization",
                    message: error.to_string(),
                })?;
            v8::Global::new(scope, value)
        };
        self.call_values_sync(&callback, &[argument], "native input")
    }
}

impl InteractiveRuntime {
    /// Deliver one queued record on the isolate thread. Listener failures use
    /// the runtime's ordinary global error path; no platform callback invokes JS.
    pub fn dispatch_input(&mut self, input: &NativeInput) -> Result<(), RuntimeError> {
        self.runtime.dispatch_input(input)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    deno_core::extension!(runtime_test, deps = [threejs_native_bootstrap]);

    // Fixtures execute as trusted startup extensions, never as application
    // modules. The production constructor seals their captured core afterward.
    fn trusted_fixture(source: &'static str) -> Runtime {
        let mut extension = runtime_test::init();
        extension.esm_files = vec![deno_core::ExtensionFileSource::new_computed(
            "ext:runtime_test/fixture.js",
            std::sync::Arc::from(source),
        )]
        .into();
        extension.esm_entry_point = Some("ext:runtime_test/fixture.js");
        let mut runtime =
            Runtime::construct_with_extensions(crate::new_instance(), None, None, vec![extension]);
        runtime.js.execute_script("trusted-fixture:sealed", "for (const key of ['Deno', '__bootstrap', '__infra']) if (key in globalThis) throw Error('Bootstrap global leaked: ' + key);").unwrap();
        runtime
    }

    #[tokio::test(flavor = "current_thread")]
    async fn captured_input_and_animation_bindings_keep_trust_and_microtask_order() {
        for source in [
            include_str!("../tests/fixtures/input.mjs"),
            include_str!("../tests/fixtures/animation.mjs"),
        ] {
            let _runtime = trusted_fixture(source);
        }
    }

    fn bind_test_callback(runtime: &mut Runtime, source: &'static str) {
        let callback = runtime
            .js
            .execute_script("input-test:callback", format!("({source})"))
            .unwrap();
        deno_core::scope!(scope, runtime.js);
        let callback = v8::Local::new(scope, callback);
        let callback = v8::Local::<v8::Function>::try_from(callback).unwrap();
        *runtime.input.borrow_mut() = Some(v8::Global::new(scope, callback));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn input_values_cross_the_v8_boundary_and_failures_keep_the_phase() {
        let mut runtime = Runtime::new();
        assert!(matches!(
            runtime.dispatch_input(&NativeInput::Focus { focused: true }),
            Err(RuntimeError::ExecutionMode(_))
        ));
        bind_test_callback(
            &mut runtime,
            "value => { globalThis.observedInput = value; }",
        );
        runtime
            .dispatch_input(&NativeInput::Key {
                pressed: true,
                key: "é".into(),
                code: "Digit2".into(),
                location: 0,
                repeat: true,
                modifiers: InputModifiers {
                    shift_key: true,
                    ..Default::default()
                },
            })
            .unwrap();
        runtime.js.execute_script("input-test", "if (observedInput.kind !== 'key' || observedInput.key !== 'é' || observedInput.code !== 'Digit2' || !observedInput.repeat || !observedInput.modifiers.shiftKey || observedInput.modifiers.ctrlKey) throw Error('input record changed');").unwrap();
        bind_test_callback(
            &mut runtime,
            "() => { throw Error('input callback failed'); }",
        );
        let error = runtime
            .dispatch_input(&NativeInput::Focus { focused: false })
            .unwrap_err();
        assert!(error.to_string().contains("JavaScript native input failed"));
        assert!(error.to_string().contains("input callback failed"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn serialized_wheel_reaches_the_actual_javascript_event_dispatcher() {
        let mut runtime = trusted_fixture(include_str!("../tests/fixtures/input-binding.mjs"));
        runtime
            .dispatch_input(&NativeInput::Wheel {
                position: InputPosition { x: 120.5, y: 80.25 },
                delta_x: -6.0,
                delta_y: 10.0,
                delta_mode: 0,
                buttons: 4,
                modifiers: InputModifiers {
                    ctrl_key: true,
                    ..Default::default()
                },
            })
            .unwrap();
        runtime.js.execute_script("wheel-input-test", "const event = observedNativeWheel; if (!(event instanceof Event) || event.type !== 'wheel' || !event.isTrusted || event.clientX !== 120.5 || event.clientY !== 80.25 || event.deltaX !== -6 || event.deltaY !== 10 || event.deltaMode !== 0 || event.buttons !== 4 || !event.ctrlKey) throw Error('wheel serialization/dispatch mismatch');").unwrap();
    }
}
