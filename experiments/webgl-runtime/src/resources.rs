use std::{collections::HashMap, error::Error, fmt};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResourceKind {
    Buffer,
    UniformLocation,
    Shader,
    Program,
    Texture,
    Framebuffer,
    Renderbuffer,
    VertexArray,
    Sampler,
    Query,
    Sync,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResourceError {
    Exhausted,
    InvalidHandle,
    WrongContext,
    WrongKind,
}

impl fmt::Display for ResourceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Exhausted => "WebGL resource handle space is exhausted",
            Self::InvalidHandle => "WebGL resource handle is unknown or deleted",
            Self::WrongContext => "WebGL resource belongs to another context",
            Self::WrongKind => "WebGL resource has a different kind",
        })
    }
}

impl Error for ResourceError {}

struct Entry<T> {
    context: u32,
    kind: ResourceKind,
    payload: T,
}

/// One registry spans every context that can exchange JS resource wrappers.
/// IDs are independent of native values; zero is invalid and issued IDs are
/// never reused. The caller supplies context identities that are not recycled
/// while old wrappers can reference them, and translates errors to WebGL rules.
///
/// This owns identity and Rust payload storage, not native GL deletion. Native
/// resources must be released by the caller or their context before discarding
/// payloads. Failed insertion drops its payload without issuing a handle.
pub struct Registry<T> {
    entries: HashMap<u32, Entry<T>>,
    next_id: u64,
}

impl<T> Default for Registry<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> Registry<T> {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
            next_id: 1,
        }
    }

    pub fn insert(
        &mut self,
        context: u32,
        kind: ResourceKind,
        payload: T,
    ) -> Result<u32, ResourceError> {
        let id = u32::try_from(self.next_id).map_err(|_| ResourceError::Exhausted)?;
        self.next_id += 1;
        self.entries.insert(
            id,
            Entry {
                context,
                kind,
                payload,
            },
        );
        Ok(id)
    }

    pub fn get(&self, context: u32, kind: ResourceKind, id: u32) -> Result<&T, ResourceError> {
        let entry = self.entries.get(&id).ok_or(ResourceError::InvalidHandle)?;
        Self::validate(entry, context, kind)?;
        Ok(&entry.payload)
    }

    pub fn get_mut(
        &mut self,
        context: u32,
        kind: ResourceKind,
        id: u32,
    ) -> Result<&mut T, ResourceError> {
        let entry = self
            .entries
            .get_mut(&id)
            .ok_or(ResourceError::InvalidHandle)?;
        Self::validate(entry, context, kind)?;
        Ok(&mut entry.payload)
    }

    pub fn remove(
        &mut self,
        context: u32,
        kind: ResourceKind,
        id: u32,
    ) -> Result<T, ResourceError> {
        self.get(context, kind, id)?;
        Ok(self.entries.remove(&id).unwrap().payload)
    }

    /// Invalidate a destroyed context's handles and drop its payloads. Call only
    /// after native context teardown has released the corresponding GL objects.
    pub fn remove_context(&mut self, context: u32) -> usize {
        let before = self.entries.len();
        self.entries.retain(|_, entry| entry.context != context);
        before - self.entries.len()
    }

    fn validate(entry: &Entry<T>, context: u32, kind: ResourceKind) -> Result<(), ResourceError> {
        if entry.context != context {
            Err(ResourceError::WrongContext)
        } else if entry.kind != kind {
            Err(ResourceError::WrongKind)
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Registry, ResourceError, ResourceKind};
    use std::{cell::Cell, rc::Rc};

    #[test]
    fn foreign_context_and_wrong_kind_cannot_read_mutate_or_delete() {
        let mut registry = Registry::new();
        let shader = registry.insert(10, ResourceKind::Shader, 91).unwrap();
        let other = registry.insert(20, ResourceKind::Shader, 91).unwrap();
        assert_ne!(shader, other);
        assert_ne!(shader, 91);
        for (context, kind, expected) in [
            (20, ResourceKind::Shader, ResourceError::WrongContext),
            (10, ResourceKind::Program, ResourceError::WrongKind),
        ] {
            assert_eq!(registry.get(context, kind, shader), Err(expected));
            assert_eq!(registry.get_mut(context, kind, shader), Err(expected));
            assert_eq!(registry.remove(context, kind, shader), Err(expected));
        }
        *registry.get_mut(10, ResourceKind::Shader, shader).unwrap() = 92;
        assert_eq!(registry.get(10, ResourceKind::Shader, shader), Ok(&92));
        assert_eq!(registry.get(20, ResourceKind::Shader, other), Ok(&91));
    }

    #[test]
    fn native_name_reuse_cannot_revive_a_deleted_handle() {
        let mut registry = Registry::new();
        let old = registry.insert(10, ResourceKind::Buffer, 73).unwrap();
        assert_eq!(registry.remove(10, ResourceKind::Buffer, old), Ok(73));
        let new = registry.insert(10, ResourceKind::Buffer, 73).unwrap();
        assert!(new > old);
        for invalid in [0, old, new + 1] {
            assert_eq!(
                registry.get(10, ResourceKind::Buffer, invalid),
                Err(ResourceError::InvalidHandle)
            );
            assert_eq!(
                registry.remove(10, ResourceKind::Buffer, invalid),
                Err(ResourceError::InvalidHandle)
            );
        }
        assert_eq!(registry.get(10, ResourceKind::Buffer, new), Ok(&73));
    }

    struct DropCount(Rc<Cell<usize>>);

    impl Drop for DropCount {
        fn drop(&mut self) {
            self.0.set(self.0.get() + 1);
        }
    }

    #[test]
    fn context_removal_drops_only_its_payloads_and_preserves_id_history() {
        let dropped = Rc::new(Cell::new(0));
        let mut registry = Registry::new();
        let first = registry
            .insert(10, ResourceKind::Shader, DropCount(dropped.clone()))
            .unwrap();
        let second = registry
            .insert(10, ResourceKind::Program, DropCount(dropped.clone()))
            .unwrap();
        let other = registry
            .insert(20, ResourceKind::Texture, DropCount(dropped.clone()))
            .unwrap();
        assert_eq!(registry.remove_context(10), 2);
        assert_eq!(dropped.get(), 2);
        assert_eq!(registry.remove_context(10), 0);
        for (id, kind) in [
            (first, ResourceKind::Shader),
            (second, ResourceKind::Program),
        ] {
            assert!(matches!(
                registry.get(10, kind, id),
                Err(ResourceError::InvalidHandle)
            ));
        }
        assert!(registry.get(20, ResourceKind::Texture, other).is_ok());
        let next = registry
            .insert(30, ResourceKind::Sync, DropCount(dropped.clone()))
            .unwrap();
        assert!(next > other);
        drop(registry);
        assert_eq!(dropped.get(), 4);
    }

    #[test]
    fn exhaustion_never_wraps_or_recovers_by_deleting() {
        let mut registry = Registry {
            next_id: u64::from(u32::MAX),
            ..Registry::new()
        };
        let last = registry.insert(10, ResourceKind::Query, 7).unwrap();
        assert_eq!(last, u32::MAX);
        assert_eq!(
            registry.insert(20, ResourceKind::Sampler, 8),
            Err(ResourceError::Exhausted)
        );
        assert_eq!(registry.get(10, ResourceKind::Query, last), Ok(&7));
        assert_eq!(registry.remove(10, ResourceKind::Query, last), Ok(7));
        assert_eq!(
            registry.insert(10, ResourceKind::Query, 7),
            Err(ResourceError::Exhausted)
        );
        assert_eq!(
            registry.get(10, ResourceKind::Query, 0),
            Err(ResourceError::InvalidHandle)
        );
    }
}
