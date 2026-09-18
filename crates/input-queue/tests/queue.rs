use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    task::{Context, Poll, Wake, Waker},
    thread,
    time::Duration,
};

use threejs_native_input_queue::{TryRecvError, TrySendError, channel};

#[derive(Debug, PartialEq, Eq)]
enum Input {
    Motion(u32, u8),
    Key(bool),
    Button(bool),
    Focus(bool),
    Wheel(i32),
}

fn coalesces(tail: &Input, incoming: &Input) -> bool {
    matches!((tail, incoming), (Input::Motion(_, old), Input::Motion(_, new)) if old == new)
}

#[test]
fn large_motion_burst_retains_only_the_latest_sample() {
    let (sender, mut receiver) = channel(1, coalesces);
    for sample in 0..100_000 {
        sender.try_send(Input::Motion(sample, 0)).unwrap();
    }
    assert_eq!(receiver.try_recv(), Ok(Input::Motion(99_999, 0)));
    assert_eq!(receiver.try_recv(), Err(TryRecvError::Empty));
}

#[test]
fn barriers_repeated_transitions_and_incompatible_motion_keep_fifo_order() {
    use Input::*;
    let (sender, mut receiver) = channel(16, coalesces);
    for input in [
        Motion(0, 0),
        Motion(1, 0),
        Key(true),
        Key(true),
        Key(false),
        Motion(2, 0),
        Motion(3, 0),
        Button(true),
        Button(false),
        Wheel(1),
        Wheel(1),
        Focus(false),
        Focus(true),
        Motion(4, 0),
        Motion(5, 1),
    ] {
        sender.try_send(input).unwrap();
    }
    drop(sender);
    for expected in [
        Motion(1, 0),
        Key(true),
        Key(true),
        Key(false),
        Motion(3, 0),
        Button(true),
        Button(false),
        Wheel(1),
        Wheel(1),
        Focus(false),
        Focus(true),
        Motion(4, 0),
        Motion(5, 1),
    ] {
        assert_eq!(receiver.try_recv(), Ok(expected));
    }
    assert_eq!(receiver.try_recv(), Err(TryRecvError::Disconnected));
}

#[test]
fn full_queue_rejects_owned_input_without_crossing_a_barrier() {
    let (sender, mut receiver) = channel(2, coalesces);
    sender.try_send(Input::Motion(1, 0)).unwrap();
    sender.try_send(Input::Key(true)).unwrap();
    assert_eq!(
        sender.try_send(Input::Motion(2, 0)),
        Err(TrySendError::Full(Input::Motion(2, 0)))
    );
    assert_eq!(
        sender.try_send(Input::Key(false)),
        Err(TrySendError::Full(Input::Key(false)))
    );
    assert_eq!(receiver.try_recv(), Ok(Input::Motion(1, 0)));
    sender.try_send(Input::Key(false)).unwrap();
    assert_eq!(receiver.try_recv(), Ok(Input::Key(true)));
    assert_eq!(receiver.try_recv(), Ok(Input::Key(false)));
}

#[test]
fn receiver_drop_closes_sender_and_returns_the_owned_rejected_value() {
    let (sender, receiver) = channel(2, |_: &String, _| false);
    sender.try_send("queued".to_owned()).unwrap();
    drop(receiver);
    let input = "owned input".to_owned();
    let allocation = input.as_ptr();
    let Err(TrySendError::Closed(returned)) = sender.try_send(input) else {
        panic!("receiver drop must close the queue");
    };
    assert_eq!(returned, "owned input");
    assert_eq!(returned.as_ptr(), allocation);
}

#[derive(Default)]
struct WakeCount(AtomicUsize);

impl Wake for WakeCount {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[test]
fn pending_receiver_wakes_on_enqueue_and_sender_drop() {
    let (sender, mut receiver) = channel(2, |_: &u8, _| false);
    let wake_count = Arc::new(WakeCount::default());
    let waker = Waker::from(wake_count.clone());
    let mut context = Context::from_waker(&waker);
    assert_eq!(receiver.poll_recv(&mut context), Poll::Pending);
    sender.try_send(1).unwrap();
    assert_eq!(wake_count.0.load(Ordering::SeqCst), 1);
    assert_eq!(receiver.poll_recv(&mut context), Poll::Ready(Some(1)));
    assert_eq!(receiver.poll_recv(&mut context), Poll::Pending);
    drop(sender);
    assert_eq!(wake_count.0.load(Ordering::SeqCst), 2);
    assert_eq!(receiver.poll_recv(&mut context), Poll::Ready(None));
    assert_eq!(receiver.try_recv(), Err(TryRecvError::Disconnected));
}

#[test]
fn newest_pending_task_owns_wakeup_and_disconnect_does_not_discard_inputs() {
    let (sender, mut receiver) = channel(2, |_: &u8, _| false);
    let old_count = Arc::new(WakeCount::default());
    let new_count = Arc::new(WakeCount::default());
    let old_waker = Waker::from(old_count.clone());
    let new_waker = Waker::from(new_count.clone());
    assert_eq!(
        receiver.poll_recv(&mut Context::from_waker(&old_waker)),
        Poll::Pending
    );
    let mut context = Context::from_waker(&new_waker);
    assert_eq!(receiver.poll_recv(&mut context), Poll::Pending);
    sender.try_send(1).unwrap();
    sender.try_send(2).unwrap();
    drop(sender);
    assert_eq!(old_count.0.load(Ordering::SeqCst), 0);
    assert_eq!(new_count.0.load(Ordering::SeqCst), 1);
    assert_eq!(receiver.poll_recv(&mut context), Poll::Ready(Some(1)));
    assert_eq!(receiver.poll_recv(&mut context), Poll::Ready(Some(2)));
    assert_eq!(receiver.poll_recv(&mut context), Poll::Ready(None));
}

#[test]
fn producer_consumer_interleaving_keeps_received_samples_and_queued_barriers() {
    let (sender, mut receiver) = channel(2, coalesces);
    let (phase_sender, phase_receiver) = mpsc::channel();
    let (continue_sender, continue_receiver) = mpsc::channel();
    let timeout = Duration::from_secs(5);
    thread::scope(|scope| {
        scope.spawn(move || {
            sender.try_send(Input::Motion(1, 0)).unwrap();
            sender.try_send(Input::Motion(2, 0)).unwrap();
            sender.try_send(Input::Button(true)).unwrap();
            phase_sender.send(1).unwrap();
            continue_receiver.recv_timeout(timeout).unwrap();
            sender.try_send(Input::Motion(3, 1)).unwrap();
            sender.try_send(Input::Motion(4, 1)).unwrap();
            phase_sender.send(2).unwrap();
            continue_receiver.recv_timeout(timeout).unwrap();
        });
        assert_eq!(phase_receiver.recv_timeout(timeout).unwrap(), 1);
        assert_eq!(receiver.try_recv(), Ok(Input::Motion(2, 0)));
        continue_sender.send(()).unwrap();
        assert_eq!(phase_receiver.recv_timeout(timeout).unwrap(), 2);
        assert_eq!(receiver.try_recv(), Ok(Input::Button(true)));
        assert_eq!(receiver.try_recv(), Ok(Input::Motion(4, 1)));
        continue_sender.send(()).unwrap();
    });
    assert_eq!(receiver.try_recv(), Err(TryRecvError::Disconnected));
}

#[test]
#[should_panic(expected = "input queue capacity must be positive")]
fn zero_capacity_is_rejected() {
    let _ = channel(0, |_: &u8, _| false);
}
