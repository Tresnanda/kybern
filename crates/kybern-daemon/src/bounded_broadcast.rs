//! Broadcast with count AND retained-byte limits. A lag is explicit, so event
//! clients replay SQLite and terminal clients resubscribe to scrollback.
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tokio::sync::{
    broadcast::error::{RecvError, SendError, TryRecvError},
    watch,
};

pub trait RetainedSize {
    fn retained_size(&self) -> usize;
}

struct Queue<T> {
    values: VecDeque<(u64, usize, T)>,
    next: u64,
    bytes: usize,
    capacity: usize,
    byte_limit: usize,
    receivers: HashMap<usize, u64>,
    next_receiver: usize,
}

pub struct Sender<T> {
    queue: Arc<Mutex<Queue<T>>>,
    changed: watch::Sender<u64>,
}

pub struct Receiver<T> {
    queue: Arc<Mutex<Queue<T>>>,
    changed: watch::Receiver<u64>,
    next: u64,
    id: usize,
}

pub fn channel<T: Clone + RetainedSize>(capacity: usize, byte_limit: usize) -> (Sender<T>, Receiver<T>) {
    assert!(capacity > 0 && byte_limit > 0);
    let (changed, receiver) = watch::channel(0);
    let queue = Arc::new(Mutex::new(Queue {
        values: VecDeque::new(),
        next: 0,
        bytes: 0,
        capacity,
        byte_limit,
        receivers: HashMap::from([(0, 0)]),
        next_receiver: 1,
    }));
    (Sender { queue: queue.clone(), changed }, Receiver { queue, changed: receiver, next: 0, id: 0 })
}

impl<T> Clone for Sender<T> {
    fn clone(&self) -> Self {
        Self { queue: self.queue.clone(), changed: self.changed.clone() }
    }
}

impl<T: Clone + RetainedSize> Sender<T> {
    pub fn receiver_count(&self) -> usize {
        self.queue.lock().unwrap().receivers.len()
    }

    pub fn subscribe(&self) -> Receiver<T> {
        let mut queue = self.queue.lock().unwrap();
        let id = queue.next_receiver;
        queue.next_receiver += 1;
        let next = queue.next;
        queue.receivers.insert(id, next);
        Receiver { queue: self.queue.clone(), changed: self.changed.subscribe(), next, id }
    }

    pub fn send(&self, value: T) -> Result<usize, SendError<T>> {
        let bytes = value.retained_size();
        let mut queue = self.queue.lock().unwrap();
        let receivers = queue.receivers.len();
        if receivers == 0 {
            return Err(SendError(value));
        }
        let sequence = queue.next;
        queue.next += 1;
        while !queue.values.is_empty() && (queue.values.len() >= queue.capacity || queue.bytes.saturating_add(bytes) > queue.byte_limit) {
            let (_, removed, _) = queue.values.pop_front().unwrap();
            queue.bytes -= removed;
        }
        // An individual oversized event is not retained. All subscribers see
        // the sequence gap and recover it from durable history, never silence.
        if bytes <= queue.byte_limit {
            queue.bytes += bytes;
            queue.values.push_back((sequence, bytes, value));
        }
        self.changed.send_replace(queue.next);
        Ok(receivers)
    }
}

impl<T> Queue<T> {
    fn release_consumed(&mut self) {
        let floor = self.receivers.values().copied().min().unwrap_or(self.next);
        while self.values.front().is_some_and(|(seq, _, _)| *seq < floor) {
            let (_, bytes, _) = self.values.pop_front().unwrap();
            self.bytes -= bytes;
        }
    }
}

impl<T> Drop for Receiver<T> {
    fn drop(&mut self) {
        let mut queue = self.queue.lock().unwrap();
        queue.receivers.remove(&self.id);
        queue.release_consumed();
    }
}

impl<T: Clone> Receiver<T> {
    pub fn try_recv(&mut self) -> Result<T, TryRecvError> {
        let mut queue = self.queue.lock().unwrap();
        let first = queue.values.front().map_or(queue.next, |(sequence, _, _)| *sequence);
        if self.next < first {
            let missed = first - self.next;
            self.next = first;
            queue.receivers.insert(self.id, self.next);
            queue.release_consumed();
            return Err(TryRecvError::Lagged(missed));
        }
        if self.next < queue.next {
            let value = queue.values[(self.next - first) as usize].2.clone();
            self.next += 1;
            queue.receivers.insert(self.id, self.next);
            queue.release_consumed();
            return Ok(value);
        }
        if self.changed.has_changed().is_err() { Err(TryRecvError::Closed) } else { Err(TryRecvError::Empty) }
    }

    pub async fn recv(&mut self) -> Result<T, RecvError> {
        loop {
            match self.try_recv() {
                Ok(value) => return Ok(value),
                Err(TryRecvError::Lagged(n)) => return Err(RecvError::Lagged(n)),
                Err(TryRecvError::Closed) => return Err(RecvError::Closed),
                Err(TryRecvError::Empty) => {
                    let _ = self.changed.changed().await;
                }
            }
        }
    }
}

/// Counts JSON without allocating an additional serialized payload. Doubling
/// the wire size allows for owned strings/containers; it is a budget estimate,
/// not an allocator or RSS measurement.
impl RetainedSize for kybern_protocol::ThreadEvent {
    fn retained_size(&self) -> usize {
        struct Count(usize);
        impl std::io::Write for Count {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0 = self.0.saturating_add(bytes.len());
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut count = Count(0);
        let _ = serde_json::to_writer(&mut count, self);
        count.0.saturating_mul(2).saturating_add(std::mem::size_of::<Self>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    impl RetainedSize for Vec<u8> {
        fn retained_size(&self) -> usize {
            self.len()
        }
    }

    #[tokio::test]
    async fn byte_lag_is_explicit_and_latest_suffix_is_ordered() {
        let (sender, mut slow) = channel(100, 10);
        let mut fast = sender.subscribe();
        for n in 0..5 {
            sender.send(vec![n; 4]).unwrap();
            assert_eq!(fast.recv().await.unwrap(), vec![n; 4]);
        }
        assert_eq!(sender.queue.lock().unwrap().bytes, 8);
        assert!(matches!(slow.recv().await, Err(RecvError::Lagged(3))));
        assert_eq!(slow.recv().await.unwrap(), vec![3; 4]);
        assert_eq!(slow.recv().await.unwrap(), vec![4; 4]);
        sender.send(vec![9; 11]).unwrap();
        assert!(matches!(slow.recv().await, Err(RecvError::Lagged(1))));
        assert_eq!(sender.queue.lock().unwrap().bytes, 0);
        drop(sender);
        assert!(matches!(slow.recv().await, Err(RecvError::Closed)));
    }

    #[tokio::test]
    async fn wakes_waiter_and_drains_after_last_sender_closes() {
        let (sender, mut receiver) = channel(2, 100);
        let task = tokio::spawn(async move { receiver.recv().await });
        tokio::task::yield_now().await;
        sender.send(vec![1]).unwrap();
        assert_eq!(task.await.unwrap().unwrap(), vec![1]);
        let mut receiver = sender.subscribe();
        sender.send(vec![2]).unwrap();
        drop(sender);
        assert_eq!(receiver.recv().await.unwrap(), vec![2]);
        assert!(matches!(receiver.recv().await, Err(RecvError::Closed)));
    }
}
