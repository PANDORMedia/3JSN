//! Synchronous delivery of package-verified resources. Draining this transport
//! does not establish font registration, CSS face selection, or FontFaceSet readiness.

use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt,
    sync::{Arc, Mutex, MutexGuard},
};

use blitz_dom::BaseDocument;
use blitz_traits::net::{Body, Bytes, Method, NetHandler, NetProvider, Request, Url};
use serde::Serialize;
use threejs_native_package::{MAX_RESOURCE_BYTES, MAX_RESOURCES, Resource, ResourceKind};

pub const PACKAGE_BASE_URL: &str = "threejsn://package/app/index.html";
const MAX_REQUESTS: u64 = 16_384;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResourceError {
    InvalidBase,
    InvalidAsset(String),
    Limit(&'static str),
    Rejected { url: String, reason: &'static str },
    Missing(String),
    Cancelled(String),
    PendingTransport,
    PendingStylesheets,
    StatePoisoned,
}

impl fmt::Display for ResourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidBase => {
                f.write_str("expected a canonical threejsn://package/app/ document URL")
            }
            Self::InvalidAsset(path) => write!(f, "invalid packaged resource: {path}"),
            Self::Limit(name) => write!(f, "package resource limit exceeded: {name}"),
            Self::Rejected { url, reason } => {
                write!(f, "package resource request rejected ({reason}): {url}")
            }
            Self::Missing(url) => write!(
                f,
                "resource is not in the verified package allowlist: {url}"
            ),
            Self::Cancelled(url) => write!(f, "package resource request was cancelled: {url}"),
            Self::PendingTransport => f.write_str("package resource delivery is still in progress"),
            Self::PendingStylesheets => {
                f.write_str("document still has pending critical stylesheets")
            }
            Self::StatePoisoned => f.write_str("package resource state was poisoned"),
        }
    }
}

impl Error for ResourceError {}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryReport {
    pub requests: u64,
    pub stylesheet_deliveries: u64,
    pub font_deliveries: u64,
    pub delivered_urls: Vec<String>,
    pub transport_drained: bool,
    pub font_registration_verified: bool,
}

struct Asset {
    bytes: Bytes,
    is_font: bool,
}

#[derive(Default)]
struct DeliveryState {
    requests: u64,
    in_flight: u64,
    stylesheet_deliveries: u64,
    font_deliveries: u64,
    delivered: BTreeSet<String>,
    error: Option<ResourceError>,
}

pub struct PackageResources {
    base_url: Url,
    assets: BTreeMap<String, Asset>,
    state: Mutex<DeliveryState>,
}

impl PackageResources {
    /// The caller verifies each resource's size/hash before passing its owned
    /// bytes here. No request can reopen a file or fall back to the network.
    pub fn new(base_url: &str, resources: Vec<Resource>) -> Result<Arc<Self>, ResourceError> {
        let base = Url::parse(base_url).map_err(|_| ResourceError::InvalidBase)?;
        if !package_url(&base) || base.as_str() != base_url || !base.path().starts_with("/app/") {
            return Err(ResourceError::InvalidBase);
        }
        if resources.len() > MAX_RESOURCES {
            return Err(ResourceError::Limit("asset count"));
        }
        let mut assets = BTreeMap::new();
        let mut total = 0usize;
        for resource in resources {
            let path = resource.path;
            if !asset_path(&path) {
                return Err(ResourceError::InvalidAsset(path));
            }
            if resource.bytes.len() as u64 > resource.kind.byte_limit() {
                return Err(ResourceError::Limit(match resource.kind {
                ResourceKind::Font => "font bytes",
                ResourceKind::Stylesheet => "stylesheet bytes",
                ResourceKind::Image => "image bytes",
                }));
            }
            total = total
                .checked_add(resource.bytes.len())
                .ok_or(ResourceError::Limit("total bytes"))?;
            if total as u64 > MAX_RESOURCE_BYTES {
                return Err(ResourceError::Limit("total bytes"));
            }
            let is_font = match resource.kind {
                ResourceKind::Font => true,
                ResourceKind::Stylesheet => false,
                ResourceKind::Image => return Err(ResourceError::InvalidAsset(path)),
            };
            if !is_font && std::str::from_utf8(&resource.bytes).is_err() {
                return Err(ResourceError::InvalidAsset(path));
            }
            let mut url = base.clone();
            url.set_path(&format!("/{path}"));
            let asset = Asset {
                bytes: Bytes::from(resource.bytes),
                is_font,
            };
            if assets.insert(url.to_string(), asset).is_some() {
                return Err(ResourceError::InvalidAsset(path));
            }
        }
        Ok(Arc::new(Self {
            base_url: base,
            assets,
            state: Mutex::new(DeliveryState::default()),
        }))
    }

    pub fn base_url(&self) -> &str {
        self.base_url.as_str()
    }

    fn state(&self) -> Result<MutexGuard<'_, DeliveryState>, ResourceError> {
        self.state.lock().map_err(|_| ResourceError::StatePoisoned)
    }

    /// A rejected request stays fatal even if a later request would succeed.
    /// Check after parsing and after application callbacks that can mutate CSS.
    pub fn check(&self) -> Result<(), ResourceError> {
        match &self.state()?.error {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }

    /// `handle_messages` also consumes responses enqueued by synchronous nested
    /// imports. Upstream font decode/registration errors are not exposed here;
    /// the host must validate the registered faces separately before layout.
    pub fn drain(&self, doc: &mut BaseDocument) -> Result<(), ResourceError> {
        self.check()?;
        doc.handle_messages();
        self.check()?;
        let state = self.state()?;
        if state.in_flight != 0 {
            return Err(ResourceError::PendingTransport);
        }
        if doc.has_pending_critical_resources() {
            return Err(ResourceError::PendingStylesheets);
        }
        Ok(())
    }

    pub fn finish_initial_load(
        &self,
        doc: &mut BaseDocument,
    ) -> Result<DeliveryReport, ResourceError> {
        self.drain(doc)?;
        let state = self.state()?;
        Ok(DeliveryReport {
            requests: state.requests,
            stylesheet_deliveries: state.stylesheet_deliveries,
            font_deliveries: state.font_deliveries,
            delivered_urls: state.delivered.iter().cloned().collect(),
            transport_drained: true,
            font_registration_verified: false,
        })
    }
}

fn package_url(url: &Url) -> bool {
    url.scheme() == "threejsn"
        && url.host_str() == Some("package")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && !url.cannot_be_a_base()
}

fn asset_path(path: &str) -> bool {
    path.starts_with("app/")
        && !path.contains(['\\', '%', '?', '#'])
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|part| !part.is_empty() && !matches!(part, "." | ".."))
}

impl NetProvider for PackageResources {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let url = request.url.to_string();
        let Ok(mut state) = self.state() else { return };
        if state.error.is_some() {
            return;
        }
        state.requests += 1;
        let error = if state.requests > MAX_REQUESTS {
            Some(ResourceError::Limit("request count"))
        } else if request
            .signal
            .as_ref()
            .is_some_and(|signal| signal.aborted())
        {
            Some(ResourceError::Cancelled(url.clone()))
        } else if request.method != Method::GET
            || !matches!(request.body, Body::Empty)
            || !request.headers.is_empty()
        {
            Some(ResourceError::Rejected {
                url: url.clone(),
                reason: "only GET with an empty body and no headers is supported",
            })
        } else if !package_url(&request.url) {
            Some(ResourceError::Rejected {
                url: url.clone(),
                reason: "origin, credentials, port, query or fragment",
            })
        } else if !self.assets.contains_key(&url) {
            Some(ResourceError::Missing(url.clone()))
        } else {
            None
        };
        if let Some(error) = error {
            // NetHandler has no error callback. Dropping it and recording a
            // sticky failure avoids fabricating a successful empty response.
            state.error = Some(error);
            return;
        }
        let asset = &self.assets[&url];
        state.in_flight += 1;
        drop(state);

        // Parsing a CSS response can synchronously request more resources.
        // Never hold the state lock while invoking the upstream handler.
        handler.bytes(url.clone(), asset.bytes.clone());

        if let Ok(mut state) = self.state() {
            state.in_flight -= 1;
            if asset.is_font {
                state.font_deliveries += 1;
            } else {
                state.stylesheet_deliveries += 1;
            }
            state.delivered.insert(url);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use blitz_dom::DocumentConfig;
    use blitz_html::HtmlDocument;
    use blitz_traits::net::AbortController;

    struct Capture(Arc<Mutex<Vec<(String, Bytes)>>>);
    impl NetHandler for Capture {
        fn bytes(self: Box<Self>, url: String, bytes: Bytes) {
            self.0.lock().unwrap().push((url, bytes));
        }
    }

    fn asset(path: &str, kind: ResourceKind, bytes: &[u8]) -> Resource {
        Resource {
            path: path.into(),
            kind,
            bytes: bytes.to_vec(),
        }
    }

    fn provider() -> Arc<PackageResources> {
        PackageResources::new(
            PACKAGE_BASE_URL,
            vec![asset(
                "app/fonts/font.woff2",
                ResourceKind::Font,
                b"transport-only",
            )],
        )
        .unwrap()
    }

    fn capture() -> (Box<dyn NetHandler>, Arc<Mutex<Vec<(String, Bytes)>>>) {
        let output = Arc::new(Mutex::new(Vec::new()));
        (Box::new(Capture(output.clone())), output)
    }

    #[test]
    fn delivers_exact_verified_bytes_without_claiming_font_registration() {
        let provider = provider();
        let (handler, output) = capture();
        let url = Url::parse(PACKAGE_BASE_URL)
            .unwrap()
            .join("fonts/font.woff2")
            .unwrap();
        provider.fetch(7, Request::get(url.clone()), handler);
        assert_eq!(
            output.lock().unwrap().as_slice(),
            &[(url.to_string(), Bytes::from_static(b"transport-only"))]
        );
        let mut doc = BaseDocument::new(DocumentConfig::default());
        let report = provider.finish_initial_load(&mut doc).unwrap();
        assert_eq!(
            (
                report.requests,
                report.font_deliveries,
                report.stylesheet_deliveries
            ),
            (1, 1, 0)
        );
        assert!(report.transport_drained);
        assert!(!report.font_registration_verified);
    }

    #[test]
    fn rejected_requests_are_sticky_and_never_receive_bytes() {
        for target in [
            "https://package/app/fonts/font.woff2",
            "file:///app/fonts/font.woff2",
            "threejsn://other/app/fonts/font.woff2",
            "threejsn://user@package/app/fonts/font.woff2",
            "threejsn://package:80/app/fonts/font.woff2",
            "threejsn://package/app/fonts/font.woff2?cache=1",
            "threejsn://package/app/fonts/font.woff2#face",
            "threejsn://package/app/fonts/%66ont.woff2",
            "threejsn://package/app/fonts/missing.woff2",
        ] {
            let provider = provider();
            let (handler, output) = capture();
            provider.fetch(1, Request::get(Url::parse(target).unwrap()), handler);
            let first = provider.check().unwrap_err();
            let (handler, later) = capture();
            provider.fetch(
                1,
                Request::get(
                    Url::parse(PACKAGE_BASE_URL)
                        .unwrap()
                        .join("fonts/font.woff2")
                        .unwrap(),
                ),
                handler,
            );
            assert!(output.lock().unwrap().is_empty(), "{target}");
            assert!(later.lock().unwrap().is_empty(), "{target}");
            assert_eq!(provider.check().unwrap_err(), first);
        }
    }

    #[test]
    fn rejects_cancelled_and_non_get_requests() {
        let provider = provider();
        let controller = AbortController::default();
        let mut request = Request::get(
            Url::parse(PACKAGE_BASE_URL)
                .unwrap()
                .join("fonts/font.woff2")
                .unwrap(),
        )
        .signal(controller.signal.clone());
        controller.abort();
        let (handler, output) = capture();
        provider.fetch(1, request.clone(), handler);
        assert!(matches!(provider.check(), Err(ResourceError::Cancelled(_))));
        assert!(output.lock().unwrap().is_empty());
        let provider = self::provider();
        request.signal = None;
        request.method = Method::POST;
        let (handler, _) = capture();
        provider.fetch(1, request, handler);
        assert!(matches!(
            provider.check(),
            Err(ResourceError::Rejected { .. })
        ));
    }

    #[test]
    fn drains_real_linked_and_nested_stylesheet_responses_before_layout() {
        let provider = PackageResources::new(
            PACKAGE_BASE_URL,
            vec![
                asset(
                    "app/styles/main.css",
                    ResourceKind::Stylesheet,
                    b"@import './nested.css'; #subject { width: 23px; }",
                ),
                asset(
                    "app/styles/nested.css",
                    ResourceKind::Stylesheet,
                    b"#subject { height: 17px; }",
                ),
            ],
        )
        .unwrap();
        let mut doc = HtmlDocument::from_html(
            "<!doctype html><link rel=stylesheet href='./styles/main.css'><div id=subject></div>",
            DocumentConfig {
                base_url: Some(provider.base_url().into()),
                net_provider: Some(provider.clone()),
                ..Default::default()
            },
        )
        .into_inner();
        let report = provider.finish_initial_load(&mut doc).unwrap();
        assert_eq!(
            (report.stylesheet_deliveries, report.font_deliveries),
            (2, 0)
        );
        assert!(!doc.has_pending_critical_resources());
        doc.resolve(0.0);
        let node = doc.get_element_by_id("subject").unwrap();
        let layout = doc.get_node(node).unwrap().final_layout();
        assert_eq!((layout.size.width, layout.size.height), (23.0, 17.0));
    }

    #[test]
    fn missing_import_is_reported_before_layout() {
        let provider = PackageResources::new(
            PACKAGE_BASE_URL,
            vec![asset(
                "app/styles/main.css",
                ResourceKind::Stylesheet,
                b"@import './missing.css';",
            )],
        )
        .unwrap();
        let mut doc = HtmlDocument::from_html(
            "<!doctype html><link rel=stylesheet href='./styles/main.css'><div></div>",
            DocumentConfig {
                base_url: Some(provider.base_url().into()),
                net_provider: Some(provider.clone()),
                ..Default::default()
            },
        )
        .into_inner();
        assert!(matches!(
            provider.finish_initial_load(&mut doc),
            Err(ResourceError::Missing(_))
        ));
    }

    #[test]
    fn rejects_ambiguous_asset_paths_and_invalid_bases() {
        for path in [
            "app/../secret.woff2",
            "app//font.woff2",
            "app/fonts/%66ont.woff2",
            "app/font.woff2#x",
            "app\\font.woff2",
        ] {
            assert!(matches!(
                PackageResources::new(PACKAGE_BASE_URL, vec![asset(path, ResourceKind::Font, b"")]),
                Err(ResourceError::InvalidAsset(_))
            ));
        }
        for base in [
            "3jsn://package/app/index.html",
            "https://package/app/index.html",
            "threejsn://other/app/index.html",
            "threejsn://package/app/index.html?x",
        ] {
            assert!(matches!(
                PackageResources::new(base, vec![]),
                Err(ResourceError::InvalidBase)
            ));
        }
        assert!(matches!(
            PackageResources::new(
                PACKAGE_BASE_URL,
                vec![
                    asset("app/font.woff2", ResourceKind::Font, b"a"),
                    asset("app/font.woff2", ResourceKind::Font, b"b")
                ]
            ),
            Err(ResourceError::InvalidAsset(_))
        ));
    }

    #[test]
    fn request_budget_bounds_repeated_delivery() {
        let provider = provider();
        let url = Url::parse(PACKAGE_BASE_URL)
            .unwrap()
            .join("fonts/font.woff2")
            .unwrap();
        for _ in 0..=MAX_REQUESTS {
            let (handler, _) = capture();
            provider.fetch(1, Request::get(url.clone()), handler);
        }
        assert_eq!(provider.check(), Err(ResourceError::Limit("request count")));
    }

    #[test]
    fn asset_count_uses_the_package_limit() {
        let assets = (0..=MAX_RESOURCES)
            .map(|i| asset(&format!("app/fonts/{i}.otf"), ResourceKind::Font, b""))
            .collect();
        assert!(matches!(
            PackageResources::new(PACKAGE_BASE_URL, assets),
            Err(ResourceError::Limit("asset count"))
        ));
    }

    #[test]
    fn font_and_stylesheet_limits_are_role_specific_and_inclusive() {
        for (kind, expected) in [
            (ResourceKind::Font, "font bytes"),
            (ResourceKind::Stylesheet, "stylesheet bytes"),
        ] {
            let make = |extra| Resource {
                path: "app/resource".into(),
                kind,
                bytes: vec![b' '; kind.byte_limit() as usize + extra],
            };
            assert!(PackageResources::new(PACKAGE_BASE_URL, vec![make(0)]).is_ok());
            assert!(matches!(
                PackageResources::new(PACKAGE_BASE_URL, vec![make(1)]),
                Err(ResourceError::Limit(name)) if name == expected
            ));
        }
    }

    #[test]
    fn aggregate_stored_bytes_are_bounded_independently_of_each_asset() {
        let mut assets = (0..4)
            .map(|i| Resource {
                path: format!("app/fonts/{i}.otf"),
                kind: ResourceKind::Font,
                bytes: vec![0; ResourceKind::Font.byte_limit() as usize],
            })
            .collect::<Vec<_>>();
        assert_eq!(
            assets.iter().map(|a| a.bytes.len() as u64).sum::<u64>(),
            MAX_RESOURCE_BYTES
        );
        assets.push(asset("app/styles/main.css", ResourceKind::Stylesheet, b" "));
        assert!(matches!(
            PackageResources::new(PACKAGE_BASE_URL, assets),
            Err(ResourceError::Limit("total bytes"))
        ));
    }
}
