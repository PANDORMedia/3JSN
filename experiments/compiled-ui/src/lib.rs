//! A bounded initial-tree loader into Blitz's authoritative live document.
//! CSS remains parsed by Blitz and arbitrary dynamic HTML uses the configured
//! parser provider. This experiment does not establish parser omission.

pub mod contract;

use std::{error::Error, fmt, sync::Arc};

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
    Ok(load_validated(&input, config))
}

pub fn load(input: &CompiledUi, config: DocumentConfig) -> Result<LoadedUi, LoadError> {
    input.validate()?;
    Ok(load_validated(input, config))
}

fn load_validated(input: &CompiledUi, mut config: DocumentConfig) -> LoadedUi {
    // Match HtmlDocument's UA policy, including callers supplying extra sheets.
    if let Some(sheets) = &mut config.ua_stylesheets
        && !sheets.iter().any(|sheet| sheet == DEFAULT_CSS)
    {
        sheets.push(DEFAULT_CSS.to_owned());
    }
    let dynamic_html_parser_provider = if config.html_parser_provider.is_some() {
        "caller-provided-unverified"
    } else {
        "blitz-html"
    };
    if config.html_parser_provider.is_none() {
        config.html_parser_provider = Some(Arc::new(blitz_html::HtmlProvider));
    }
    let mut document = BaseDocument::new(config);
    let mut node_ids = vec![None; input.nodes.len()];
    let mut omitted_doctype_nodes = Vec::new();
    node_ids[0] = Some(document.root_node().id);
    {
        let mut mutator = document.mutate();
        for &child in input.nodes[0].children() {
            append(
                input,
                child,
                node_ids[0].unwrap(),
                &mut mutator,
                &mut node_ids,
                &mut omitted_doctype_nodes,
            );
        }
    }
    let report = LoadReport {
        ir_nodes: input.nodes.len(),
        native_nodes: node_ids.iter().flatten().count(),
        omitted_doctype_nodes,
        initial_document_html_parser_used: false,
        dynamic_html_parser_provider,
    };
    LoadedUi {
        document,
        node_ids,
        report,
    }
}

fn append(
    input: &CompiledUi,
    index: usize,
    parent: NodeId,
    mutator: &mut DocumentMutator<'_>,
    node_ids: &mut [Option<NodeId>],
    omitted: &mut Vec<usize>,
) {
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
            return;
        }
        CompiledNode::Document { .. } | CompiledNode::Fragment { .. } => {
            unreachable!("validated ownership")
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
            append(input, child, contents, mutator, node_ids, omitted);
        }
    }
    for &child in node.children() {
        append(input, child, id, mutator, node_ids, omitted);
    }
}

#[cfg(test)]
mod tests;
