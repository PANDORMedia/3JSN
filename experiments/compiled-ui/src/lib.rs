//! A bounded initial-tree loader into Blitz's authoritative live document.
//! CSS remains parsed by Blitz. The default `dynamic-html` feature installs its
//! maintained HTML provider; restricted loading omits that provider. Artifact
//! parser omission requires separate dependency and linkage evidence.

pub mod contract;

#[path = "../../html-v8/src/capabilities.rs"]
pub mod capabilities;

#[cfg(feature = "dynamic-html")]
use std::sync::Arc;
use std::{error::Error, fmt};

use blitz_dom::{
    Attribute, BaseDocument, DEFAULT_CSS, DocumentConfig, DocumentMutator, NodeId, QualName,
};
use contract::{CompiledNode, CompiledUi};
use serde::Serialize;

#[derive(Debug)]
pub enum LoadError {
    Json(serde_json::Error),
    Limit(&'static str),
    Unsupported(&'static str),
    Invalid(&'static str),
}

impl fmt::Display for LoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(error) => write!(f, "invalid compiled UI JSON: {error}"),
            Self::Limit(reason) => write!(f, "compiled UI limit exceeded: {reason}"),
            Self::Unsupported(reason) => write!(f, "unsupported compiled UI capability: {reason}"),
            Self::Invalid(reason) => write!(f, "invalid compiled UI tree: {reason}"),
        }
    }
}

impl Error for LoadError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Json(error) => Some(error),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadReport {
    pub ir_nodes: usize,
    pub native_nodes: usize,
    /// The pinned interpreted sink also drops these. No DocumentType is invented.
    pub omitted_doctype_nodes: Vec<usize>,
    /// The root tree uses construction APIs. Resource/subdocument providers may
    /// still invoke HTML parsing during attachment or later resource delivery.
    pub initial_document_html_parser_used: bool,
    /// Semantic availability; BaseDocument keeps a no-op provider when absent.
    pub dynamic_html_parser_provider: &'static str,
}

pub struct LoadedUi {
    pub document: BaseDocument,
    /// Initial IR-to-node mapping; IDs may become stale after later removal.
    /// Doctype entries alone have no native node.
    pub node_ids: Vec<Option<NodeId>>,
    pub report: LoadReport,
}

pub fn load_json(bytes: &[u8], config: DocumentConfig) -> Result<LoadedUi, LoadError> {
    let input = CompiledUi::from_json(bytes)?;
    load_validated(&input, config, false)
}

pub fn load(input: &CompiledUi, config: DocumentConfig) -> Result<LoadedUi, LoadError> {
    input.validate()?;
    load_validated(input, config, false)
}

/// Startup gate for an explicitly restricted host. No default parser is
/// installed, and caller-supplied parsers are rejected. Live DOM operations must
/// separately enforce the same capability; BaseDocument is not a sandbox.
pub fn load_json_restricted(bytes: &[u8], config: DocumentConfig) -> Result<LoadedUi, LoadError> {
    let input = CompiledUi::from_json(bytes)?;
    load_validated(&input, config, true)
}

/// Typed-IR counterpart of [`load_json_restricted`].
pub fn load_restricted(input: &CompiledUi, config: DocumentConfig) -> Result<LoadedUi, LoadError> {
    input.validate()?;
    load_validated(input, config, true)
}

fn load_validated(
    input: &CompiledUi,
    mut config: DocumentConfig,
    restricted: bool,
) -> Result<LoadedUi, LoadError> {
    if restricted && config.html_parser_provider.is_some() {
        return Err(LoadError::Unsupported(
            "restricted loading rejects a caller-provided HTML parser",
        ));
    }
    let default_parser_enabled = cfg!(feature = "dynamic-html") && !restricted;
    if config.html_parser_provider.is_none() && !default_parser_enabled {
        for node in &input.nodes {
            if let CompiledNode::Element {
                namespace, name, ..
            } = node
                && let Some(requirement) =
                    capabilities::element_html_parser_requirement(namespace, name)
            {
                return Err(LoadError::Unsupported(requirement));
            }
        }
    }
    // Match HtmlDocument's UA policy, including callers supplying extra sheets.
    if let Some(sheets) = &mut config.ua_stylesheets
        && !sheets.iter().any(|sheet| sheet == DEFAULT_CSS)
    {
        sheets.push(DEFAULT_CSS.to_owned());
    }
    let dynamic_html_parser_provider = if config.html_parser_provider.is_some() {
        "caller-provided-unverified"
    } else if default_parser_enabled {
        "blitz-html"
    } else {
        "absent"
    };
    #[cfg(feature = "dynamic-html")]
    if config.html_parser_provider.is_none() && default_parser_enabled {
        config.html_parser_provider = Some(Arc::new(blitz_html::HtmlProvider));
    }
    let mut document = BaseDocument::new(config);
    let mut node_ids = vec![None; input.nodes.len()];
    let mut omitted_doctype_nodes = Vec::new();
    let root_id = document.root_node().id;
    node_ids[0] = Some(root_id);
    {
        let mut mutator = document.mutate();
        for &child in input.nodes[0].children() {
            append(
                input,
                child,
                root_id,
                &mut mutator,
                &mut node_ids,
                &mut omitted_doctype_nodes,
            )?;
        }
    }
    let report = LoadReport {
        ir_nodes: input.nodes.len(),
        native_nodes: node_ids.iter().flatten().count(),
        omitted_doctype_nodes,
        initial_document_html_parser_used: false,
        dynamic_html_parser_provider,
    };
    Ok(LoadedUi {
        document,
        node_ids,
        report,
    })
}

fn append(
    input: &CompiledUi,
    index: usize,
    parent: NodeId,
    mutator: &mut DocumentMutator<'_>,
    node_ids: &mut [Option<NodeId>],
    omitted: &mut Vec<usize>,
) -> Result<(), LoadError> {
    let node = &input.nodes[index];
    let id = match node {
        CompiledNode::Element {
            name,
            namespace,
            prefix,
            attributes,
            ..
        } => {
            let name = QualName::new(
                prefix.as_deref().map(Into::into),
                namespace.as_str().into(),
                name.as_str().into(),
            );
            let attrs = attributes
                .iter()
                .map(|attr| Attribute {
                    name: QualName::new(
                        attr.prefix.as_deref().map(Into::into),
                        attr.namespace.as_deref().unwrap_or("").into(),
                        attr.name.as_str().into(),
                    ),
                    value: attr.value.clone(),
                })
                .collect();
            mutator.create_element(name, attrs)
        }
        CompiledNode::Text { value, .. } => mutator.create_text_node(value),
        CompiledNode::Comment { value, .. } => mutator.create_comment_node(value),
        CompiledNode::Doctype { .. } => {
            omitted.push(index);
            return Ok(());
        }
        CompiledNode::Document { .. } | CompiledNode::Fragment { .. } => {
            return Err(LoadError::Invalid(
                "unexpected document or fragment during construction",
            ));
        }
    };
    node_ids[index] = Some(id);
    mutator.append_children(parent, &[id]);
    if let CompiledNode::Element {
        template_contents: Some(fragment),
        ..
    } = node
    {
        let contents = mutator.template_contents(id);
        node_ids[*fragment] = Some(contents);
        for &child in input.nodes[*fragment].children() {
            append(input, child, contents, mutator, node_ids, omitted)?;
        }
    }
    for &child in node.children() {
        append(input, child, id, mutator, node_ids, omitted)?;
    }
    Ok(())
}

#[cfg(all(test, feature = "dynamic-html"))]
mod tests;

#[cfg(test)]
mod parser_policy_tests;
