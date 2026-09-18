//! A bounded input FIFO with caller-defined coalescing of adjacent tail samples.
//!
//! There is one sender and one receiver, neither cloneable. Accepted discrete
//! transitions retain their order when the caller's predicate excludes them.
//! Coalescing retains the newest sample, so this is not a raw-motion recorder.

#![forbid(unsafe_code)]

use std::{
    collections::VecDeque,
    fmt,
    sync::{Arc, Mutex, MutexGuard},
    task::{Context, Poll, Waker},
};

struct State<T> {
    queue: VecDeque<T>,
    sender_alive: bool,
    receiver_alive: bool,
    receiver_waker: Option<Waker>,
}

struct Shared<T> {
    state: Mutex<State<T>>,
    capacity: usize,
    can_coalesce: fn(&T, &T) -> bool,
}

impl<T> Shared<T> {
    fn lock(&self) -> MutexGuard<'_, State<T>> {
        // The caller's predicate can panic, but runs before any queue mutation.
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// The sole producer. Sending never waits for queue capacity.
pub struct Sender<T> {
    shared: Arc<Shared<T>>,
}

/// The sole consumer. Queued inputs remain readable after the sender is dropped.
pub struct Receiver<T> {
    shared: Arc<Shared<T>>,
}

/// A rejected input remains owned by the caller.
#[derive(Debug, PartialEq, Eq)]
pub enum TrySendError<T> {
    Full(T),
    Closed(T),
}

impl<T> fmt::Display for TrySendError<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Full(_) => "input queue is full",
            Self::Closed(_) => "input queue receiver is closed",
        })
    }
}

impl<T: fmt::Debug> std::error::Error for TrySendError<T> {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TryRecvError {
    /// No input is queued, but the sender still exists.
    Empty,
    /// The sender is gone and every queued input has been received.
    Disconnected,
}

impl fmt::Display for TryRecvError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Empty => "input queue is empty",
            Self::Disconnected => "input queue sender is disconnected",
        })
    }
}

impl std::error::Error for TryRecvError {}

/// Creates a FIFO holding at most `capacity` inputs.
///
/// `can_coalesce(queued_tail, incoming)` may replace only the current queued
/// tail. It must reject discrete transitions and incompatible motion snapshots.
/// The predicate runs under a mutex and must not block or reenter this queue.
/// Operations may briefly contend on that mutex, but never wait for capacity.
///
/// # Panics
/// Panics if `capacity` is zero.
pub fn channel<T>(capacity: usize, can_coalesce: fn(&T, &T) -> bool) -> (Sender<T>, Receiver<T>) {
    assert!(capacity > 0, "input queue capacity must be positive");
    let shared = Arc::new(Shared {
        state: Mutex::new(State {
            queue: VecDeque::with_capacity(capacity),
            sender_alive: true,
            receiver_alive: true,
            receiver_waker: None,
        }),
        capacity,
        can_coalesce,
    });
    (
        Sender {
            shared: shared.clone(),
        },
        Receiver { shared },
    )
}

impl<T> Sender<T> {
    /// Replaces a compatible tail or appends the input without waiting for space.
    /// A compatible tail can be replaced even when the queue is full.
    ///
    /// # Panics
    /// A predicate panic propagates before the queue is changed; subsequent
    /// operations recover the poisoned mutex. Predicate side effects, including
    /// changes to interior-mutable inputs, are not rolled back.
    pub fn try_send(&self, input: T) -> Result<(), TrySendError<T>> {
        let (replaced, waker) = {
            let mut state = self.shared.lock();
            if !state.receiver_alive {
                return Err(TrySendError::Closed(input));
            }
            let coalesce = state
                .queue
                .back()
                .is_some_and(|tail| (self.shared.can_coalesce)(tail, &input));
            let replaced = if coalesce {
                Some(std::mem::replace(state.queue.back_mut().unwrap(), input))
            } else {
                if state.queue.len() == self.shared.capacity {
                    return Err(TrySendError::Full(input));
                }
                state.queue.push_back(input);
                None
            };
            (replaced, state.receiver_waker.take())
        };
        // Wakers and input destructors may execute caller code.
        if let Some(waker) = waker {
            waker.wake();
        }
        drop(replaced);
        Ok(())
    }
}

impl<T> Drop for Sender<T> {
    fn drop(&mut self) {
        let waker = {
            let mut state = self.shared.lock();
            state.sender_alive = false;
            state.receiver_waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

impl<T> Receiver<T> {
    /// Returns the oldest queued input, or distinguishes empty from disconnected.
    pub fn try_recv(&mut self) -> Result<T, TryRecvError> {
        let mut state = self.shared.lock();
        state.queue.pop_front().ok_or(if state.sender_alive {
            TryRecvError::Empty
        } else {
            TryRecvError::Disconnected
        })
    }

    /// Registers the current task when empty, returning `None` only after drain
    /// and sender disconnection. The most recent pending poll owns the wakeup.
    pub fn poll_recv(&mut self, context: &mut Context<'_>) -> Poll<Option<T>> {
        let next_waker = context.waker().clone();
        let mut previous_waker = None;
        let result = {
            let mut state = self.shared.lock();
            if let Some(input) = state.queue.pop_front() {
                Poll::Ready(Some(input))
            } else if !state.sender_alive {
                Poll::Ready(None)
            } else {
                if state
                    .receiver_waker
                    .as_ref()
                    .is_none_or(|waker| !waker.will_wake(&next_waker))
                {
                    previous_waker = state.receiver_waker.replace(next_waker);
                }
                Poll::Pending
            }
        };
        drop(previous_waker);
        result
    }
}

impl<T> Drop for Receiver<T> {
    fn drop(&mut self) {
        let (queue, waker) = {
            let mut state = self.shared.lock();
            state.receiver_alive = false;
            (
                std::mem::take(&mut state.queue),
                state.receiver_waker.take(),
            )
        };
        drop(queue);
        drop(waker);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        panic::{AssertUnwindSafe, catch_unwind},
        sync::{
            Weak,
            atomic::{AtomicUsize, Ordering},
        },
        task::Wake,
    };

    #[derive(Default)]
    struct Checks {
        calls: AtomicUsize,
        lock_failures: AtomicUsize,
    }

    impl Checks {
        fn assert_unlocked(&self, calls: usize) {
            assert_eq!(self.calls.load(Ordering::SeqCst), calls);
            assert_eq!(self.lock_failures.load(Ordering::SeqCst), 0);
        }
    }

    struct LockProbe<T> {
        shared: Weak<Shared<T>>,
        checks: Arc<Checks>,
    }

    impl<T> LockProbe<T> {
        fn new(sender: &Sender<T>, checks: &Arc<Checks>) -> Self {
            Self {
                shared: Arc::downgrade(&sender.shared),
                checks: checks.clone(),
            }
        }

        fn check(&self) {
            let shared = self.shared.upgrade().expect("an endpoint still exists");
            if shared.state.try_lock().is_err() {
                self.checks.lock_failures.fetch_add(1, Ordering::SeqCst);
            }
            self.checks.calls.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl<T> Drop for LockProbe<T> {
        fn drop(&mut self) {
            self.check();
        }
    }

    impl Wake for LockProbe<u8> {
        fn wake(self: Arc<Self>) {
            self.check();
        }
    }

    #[test]
    fn enqueue_and_sender_drop_wake_after_unlocking() {
        let (sender, mut receiver) = channel(1, |_: &u8, _| false);
        let checks = Arc::new(Checks::default());
        let waker = Waker::from(Arc::new(LockProbe::new(&sender, &checks)));
        let mut context = Context::from_waker(&waker);
        assert_eq!(receiver.poll_recv(&mut context), Poll::Pending);
        sender.try_send(1).unwrap();
        checks.assert_unlocked(1);
        assert_eq!(receiver.try_recv(), Ok(1));
        assert_eq!(receiver.poll_recv(&mut context), Poll::Pending);
        drop(sender);
        checks.assert_unlocked(2);
        assert_eq!(receiver.poll_recv(&mut context), Poll::Ready(None));
        drop(waker);
        checks.assert_unlocked(3);
    }

    #[test]
    fn replacing_and_dropping_pending_wakers_retires_them_after_unlocking() {
        let (sender, mut receiver) = channel(1, |_: &u8, _| false);
        let checks = Arc::new(Checks::default());
        let old = Waker::from(Arc::new(LockProbe::new(&sender, &checks)));
        assert_eq!(
            receiver.poll_recv(&mut Context::from_waker(&old)),
            Poll::Pending
        );
        drop(old);
        let new = Waker::from(Arc::new(LockProbe::new(&sender, &checks)));
        assert_eq!(
            receiver.poll_recv(&mut Context::from_waker(&new)),
            Poll::Pending
        );
        checks.assert_unlocked(1);
        drop(new);
        drop(receiver);
        checks.assert_unlocked(2);
    }

    #[test]
    fn replaced_and_abandoned_inputs_drop_after_unlocking() {
        struct Input {
            _probe: LockProbe<Input>,
        }
        let (sender, receiver) = channel(1, |_: &Input, _| true);
        let checks = Arc::new(Checks::default());
        for _ in 0..2 {
            assert!(
                sender
                    .try_send(Input {
                        _probe: LockProbe::new(&sender, &checks),
                    })
                    .is_ok()
            );
        }
        checks.assert_unlocked(1);
        drop(receiver);
        checks.assert_unlocked(2);
    }

    #[test]
    fn predicate_panic_preserves_fifo_and_recovers_poisoned_endpoints() {
        let (sender, mut receiver) = channel(2, |_: &u8, incoming| {
            assert_ne!(*incoming, 99, "predicate failure");
            false
        });
        sender.try_send(1).unwrap();
        let panic = catch_unwind(AssertUnwindSafe(|| sender.try_send(99)));
        assert!(panic.is_err());
        assert!(sender.shared.state.is_poisoned());
        sender.try_send(2).unwrap();
        assert_eq!(receiver.try_recv(), Ok(1));
        assert_eq!(receiver.try_recv(), Ok(2));
        let waker = Waker::noop();
        assert_eq!(
            receiver.poll_recv(&mut Context::from_waker(waker)),
            Poll::Pending
        );
        drop(sender);
        assert_eq!(
            receiver.poll_recv(&mut Context::from_waker(waker)),
            Poll::Ready(None)
        );
        assert_eq!(receiver.try_recv(), Err(TryRecvError::Disconnected));
    }
}
