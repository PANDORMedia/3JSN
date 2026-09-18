use std::fmt;

use threejs_native_runtime::{InputModifiers, InputPosition, MouseInputKind, NativeInput};
use winit::{
    dpi::PhysicalPosition,
    event::{ElementState, Modifiers, MouseButton, MouseScrollDelta, WindowEvent},
    keyboard::{
        Key, KeyCode, KeyLocation, ModifiersKeyState, ModifiersState, NamedKey, PhysicalKey,
    },
};

pub(super) const INPUT_CAPACITY: usize = 1024;

pub(super) fn coalesces_motion(previous: &NativeInput, next: &NativeInput) -> bool {
    matches!((previous, next), (
        NativeInput::Mouse {
            event: MouseInputKind::Move,
            buttons: previous_buttons,
            modifiers: previous_modifiers,
            ..
        },
        NativeInput::Mouse {
            event: MouseInputKind::Move,
            buttons: next_buttons,
            modifiers: next_modifiers,
            ..
        },
    ) if previous_buttons == next_buttons && previous_modifiers == next_modifiers)
}

#[derive(Debug)]
pub(super) enum InputError {
    UnknownPosition,
    StalePosition,
    UnsupportedButton(u16),
}

impl fmt::Display for InputError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownPosition => formatter
                .write_str("native mouse input arrived before a cursor position was available"),
            Self::StalePosition => formatter.write_str(
                "native mouse input needs a fresh cursor position after a display-scale change",
            ),
            Self::UnsupportedButton(button) => write!(
                formatter,
                "native mouse button {button} is outside the supported five-button input profile"
            ),
        }
    }
}

#[derive(Default)]
pub(super) struct InputTranslator {
    position: Option<(PhysicalPosition<f64>, f64)>,
    modifiers: ModifiersState,
    modifier_sides: [bool; 8],
    buttons: u16,
    focused: Option<bool>,
}

impl InputTranslator {
    pub(super) fn translate(
        &mut self,
        event: &WindowEvent,
        scale: f64,
    ) -> Result<Option<NativeInput>, InputError> {
        let input = match event {
            WindowEvent::ModifiersChanged(modifiers) => {
                self.reconcile_modifiers(*modifiers);
                return Ok(None);
            }
            WindowEvent::KeyboardInput {
                event,
                is_synthetic: false,
                ..
            } => {
                let pressed = event.state == ElementState::Pressed;
                self.modifier_transition(event.physical_key, pressed);
                NativeInput::Key {
                    pressed,
                    key: key_value(&event.logical_key),
                    code: code_value(event.physical_key),
                    location: match event.location {
                        KeyLocation::Standard => 0,
                        KeyLocation::Left => 1,
                        KeyLocation::Right => 2,
                        KeyLocation::Numpad => 3,
                    },
                    repeat: event.repeat,
                    modifiers: self.modifier_snapshot(),
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                self.position = Some((*position, scale));
                self.mouse(MouseInputKind::Move, 0, scale)?
            }
            WindowEvent::CursorLeft { .. } => {
                if self.position.is_none() {
                    return Ok(None);
                }
                self.mouse(MouseInputKind::Leave, 0, scale)?
            }
            WindowEvent::MouseInput { state, button, .. } => {
                let (button, mask) = mouse_button(*button)?;
                let pressed = *state == ElementState::Pressed;
                if pressed {
                    self.buttons |= mask;
                } else {
                    self.buttons &= !mask;
                }
                self.mouse(
                    if pressed {
                        MouseInputKind::Down
                    } else {
                        MouseInputKind::Up
                    },
                    button,
                    scale,
                )?
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let (delta_x, delta_y, delta_mode) = match delta {
                    MouseScrollDelta::LineDelta(x, y) => (-f64::from(*x), -f64::from(*y), 1),
                    MouseScrollDelta::PixelDelta(delta) => (-delta.x / scale, -delta.y / scale, 0),
                };
                NativeInput::Wheel {
                    position: self.css_position(scale)?,
                    delta_x,
                    delta_y,
                    delta_mode,
                    buttons: self.buttons,
                    modifiers: self.modifier_snapshot(),
                }
            }
            WindowEvent::Focused(focused) => return Ok(self.focus(*focused)),
            _ => return Ok(None),
        };
        Ok(Some(input))
    }

    pub(super) fn focus(&mut self, focused: bool) -> Option<NativeInput> {
        if self.focused == Some(focused) {
            return None;
        }
        self.focused = Some(focused);
        if !focused {
            self.modifiers = ModifiersState::empty();
            self.modifier_sides = [false; 8];
            self.buttons = 0;
        }
        Some(NativeInput::Focus { focused })
    }

    fn mouse(
        &self,
        event: MouseInputKind,
        button: i16,
        scale: f64,
    ) -> Result<NativeInput, InputError> {
        Ok(NativeInput::Mouse {
            event,
            position: self.css_position(scale)?,
            button,
            buttons: self.buttons,
            modifiers: self.modifier_snapshot(),
        })
    }

    fn css_position(&self, scale: f64) -> Result<InputPosition, InputError> {
        let (position, sample_scale) = self.position.ok_or(InputError::UnknownPosition)?;
        if sample_scale != scale {
            return Err(InputError::StalePosition);
        }
        Ok(InputPosition {
            x: position.x / scale,
            y: position.y / scale,
        })
    }

    fn modifier_snapshot(&self) -> InputModifiers {
        InputModifiers {
            alt_key: self.modifiers.alt_key(),
            ctrl_key: self.modifiers.control_key(),
            meta_key: self.modifiers.super_key(),
            shift_key: self.modifiers.shift_key(),
        }
    }

    fn modifier_transition(&mut self, physical: PhysicalKey, pressed: bool) {
        let PhysicalKey::Code(code) = physical else {
            return;
        };
        let side = match code {
            KeyCode::ShiftLeft => 0,
            KeyCode::ShiftRight => 1,
            KeyCode::ControlLeft => 2,
            KeyCode::ControlRight => 3,
            KeyCode::AltLeft => 4,
            KeyCode::AltRight => 5,
            KeyCode::SuperLeft => 6,
            KeyCode::SuperRight => 7,
            _ => return,
        };
        self.modifier_sides[side] = pressed;
        let family = side / 2;
        self.modifiers.set(
            modifier_families()[family],
            self.modifier_sides[family * 2..family * 2 + 2]
                .iter()
                .any(|down| *down),
        );
    }

    fn reconcile_modifiers(&mut self, modifiers: Modifiers) {
        self.modifiers = modifiers.state();
        let sides = [
            modifiers.lshift_state(),
            modifiers.rshift_state(),
            modifiers.lcontrol_state(),
            modifiers.rcontrol_state(),
            modifiers.lalt_state(),
            modifiers.ralt_state(),
            modifiers.lsuper_state(),
            modifiers.rsuper_state(),
        ];
        for (index, side) in sides.into_iter().enumerate() {
            if !self.modifiers.contains(modifier_families()[index / 2]) {
                self.modifier_sides[index] = false;
            } else if side == ModifiersKeyState::Pressed {
                self.modifier_sides[index] = true;
            }
        }
    }
}

fn modifier_families() -> [ModifiersState; 4] {
    [
        ModifiersState::SHIFT,
        ModifiersState::CONTROL,
        ModifiersState::ALT,
        ModifiersState::SUPER,
    ]
}

fn mouse_button(button: MouseButton) -> Result<(i16, u16), InputError> {
    Ok(match button {
        MouseButton::Left => (0, 1),
        MouseButton::Middle => (1, 4),
        MouseButton::Right => (2, 2),
        MouseButton::Back => (3, 8),
        MouseButton::Forward => (4, 16),
        MouseButton::Other(button) => return Err(InputError::UnsupportedButton(button)),
    })
}

fn key_value(key: &Key) -> String {
    match key {
        Key::Character(value) => value.to_string(),
        Key::Named(NamedKey::Space) => " ".into(),
        Key::Named(NamedKey::Super) => "Meta".into(),
        Key::Named(key) => format!("{key:?}"),
        Key::Dead(_) => "Dead".into(),
        Key::Unidentified(_) => "Unidentified".into(),
    }
}

fn code_value(key: PhysicalKey) -> String {
    match key {
        PhysicalKey::Code(KeyCode::SuperLeft) => "MetaLeft".into(),
        PhysicalKey::Code(KeyCode::SuperRight) => "MetaRight".into(),
        PhysicalKey::Code(code) => format!("{code:?}"),
        PhysicalKey::Unidentified(_) => "Unidentified".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use winit::event::{DeviceId, TouchPhase};

    #[test]
    fn modifier_transitions_precede_platform_reconciliation_and_preserve_other_side() {
        let mut translator = InputTranslator::default();
        translator.modifier_transition(PhysicalKey::Code(KeyCode::ShiftLeft), true);
        assert!(translator.modifier_snapshot().shift_key);
        translator.reconcile_modifiers(ModifiersState::SHIFT.into());
        translator.modifier_transition(PhysicalKey::Code(KeyCode::ShiftRight), true);
        translator.modifier_transition(PhysicalKey::Code(KeyCode::ShiftLeft), false);
        assert!(translator.modifier_snapshot().shift_key);
        translator.modifier_transition(PhysicalKey::Code(KeyCode::ShiftRight), false);
        assert!(!translator.modifier_snapshot().shift_key);
        translator.reconcile_modifiers((ModifiersState::CONTROL | ModifiersState::ALT).into());
        translator.focus(false);
        assert_eq!(translator.modifier_snapshot(), InputModifiers::default());
        assert!(translator.focus(false).is_none());
    }

    #[test]
    fn key_names_keep_layout_characters_separate_from_physical_codes() {
        assert_eq!(key_value(&Key::Character("é".into())), "é");
        assert_eq!(code_value(PhysicalKey::Code(KeyCode::Digit2)), "Digit2");
        assert_eq!(key_value(&Key::Named(NamedKey::Space)), " ");
        assert_eq!(key_value(&Key::Named(NamedKey::Super)), "Meta");
        assert_eq!(
            code_value(PhysicalKey::Code(KeyCode::SuperLeft)),
            "MetaLeft"
        );
        assert_eq!(key_value(&Key::Dead(Some('^'))), "Dead");
    }

    #[test]
    fn mouse_chords_and_wheel_units_use_event_time_scale_and_blur_clears_buttons() {
        let mut translator = InputTranslator::default();
        let device_id = DeviceId::dummy();
        translator
            .translate(
                &WindowEvent::CursorMoved {
                    device_id,
                    position: PhysicalPosition::new(240.0, 160.0),
                },
                2.0,
            )
            .unwrap();
        for (button, state, expected_button, expected_mask) in [
            (MouseButton::Left, ElementState::Pressed, 0, 1),
            (MouseButton::Right, ElementState::Pressed, 2, 3),
            (MouseButton::Left, ElementState::Released, 0, 2),
            (MouseButton::Right, ElementState::Released, 2, 0),
            (MouseButton::Middle, ElementState::Pressed, 1, 4),
        ] {
            let record = translator
                .translate(
                    &WindowEvent::MouseInput {
                        device_id,
                        state,
                        button,
                    },
                    2.0,
                )
                .unwrap()
                .unwrap();
            let NativeInput::Mouse {
                position,
                button,
                buttons,
                ..
            } = record
            else {
                panic!("mouse record required");
            };
            assert_eq!(position, InputPosition { x: 120.0, y: 80.0 });
            assert_eq!((button, buttons), (expected_button, expected_mask));
        }
        for (delta, x, y, mode) in [
            (MouseScrollDelta::LineDelta(2.0, -3.0), -2.0, 3.0, 1),
            (
                MouseScrollDelta::PixelDelta(PhysicalPosition::new(12.0, -20.0)),
                -6.0,
                10.0,
                0,
            ),
        ] {
            let record = translator
                .translate(
                    &WindowEvent::MouseWheel {
                        device_id,
                        delta,
                        phase: TouchPhase::Moved,
                    },
                    2.0,
                )
                .unwrap()
                .unwrap();
            let NativeInput::Wheel {
                delta_x,
                delta_y,
                delta_mode,
                ..
            } = record
            else {
                panic!("wheel record required");
            };
            assert_eq!((delta_x, delta_y, delta_mode), (x, y, mode));
        }
        translator.focus(false);
        assert_eq!(translator.buttons, 0);
        assert!(matches!(
            translator.css_position(1.0),
            Err(InputError::StalePosition)
        ));
        translator
            .translate(
                &WindowEvent::CursorMoved {
                    device_id,
                    position: PhysicalPosition::new(120.0, 80.0),
                },
                1.0,
            )
            .unwrap();
        assert_eq!(
            translator.css_position(1.0).unwrap(),
            InputPosition { x: 120.0, y: 80.0 }
        );
        assert!(matches!(
            mouse_button(MouseButton::Other(7)),
            Err(InputError::UnsupportedButton(7))
        ));
        assert!(matches!(
            InputTranslator::default().css_position(1.0),
            Err(InputError::UnknownPosition)
        ));
    }
}
