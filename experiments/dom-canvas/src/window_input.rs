use threejs_native_input_queue::{Receiver, Sender};

pub const CAPACITY: usize = 128;

#[derive(Clone, Debug, PartialEq)]
pub struct Input {
    pub kind: &'static str,
    pub x: f64,
    pub y: f64,
    pub button: i32,
    pub key: String,
}

pub fn channel() -> (Sender<Input>, Receiver<Input>) {
    threejs_native_input_queue::channel(CAPACITY, |previous: &Input, next: &Input| {
        previous.kind == "mousemove" && next.kind == "mousemove"
    })
}
