use std::collections::HashSet;

use serde::Deserialize;
use serde_json::Value;

use crate::LoadError;

pub const FORMAT: &str = "3jsn-static-ui-experiment";
pub const VERSION: u32 = 1;
pub const MAX_IR_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_SOURCE_BYTES: usize = 1024 * 1024;
pub const MAX_NODES: usize = 10_000;
pub const MAX_ATTRIBUTES: usize = 10_000;
pub const MAX_DEPTH: usize = 128;
pub const MAX_STRING_BYTES: usize = 65_536;
const HTML_NAMESPACE: &str = "http://www.w3.org/1999/xhtml";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompiledUi {
    pub format: String,
    pub version: u32,
    pub source: SourceIdentity,
    pub document: DocumentSettings,
    pub nodes: Vec<CompiledNode>,
    pub diagnostics: Vec<Value>,
    #[serde(rename = "diagnosticsTotal")]
    pub diagnostics_total: usize,
    #[serde(rename = "diagnosticsTruncated")]
    pub diagnostics_truncated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceIdentity {
    pub name: String,
    pub sha256: String,
    pub byte_length: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentSettings {
    pub mode: String,
    pub scripting_enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum CompiledNode {
    Document {
        children: Vec<usize>,
        source: Value,
    },
    Fragment {
        children: Vec<usize>,
        source: Value,
    },
    Element {
        name: String,
        namespace: String,
        prefix: Option<String>,
        attributes: Vec<CompiledAttribute>,
        children: Vec<usize>,
        #[serde(rename = "templateContents")]
        template_contents: Option<usize>,
        source: Value,
    },
    Text {
        value: String,
        source: Value,
    },
    Comment {
        value: String,
        source: Value,
    },
    Doctype {
        name: String,
        #[serde(rename = "publicId")]
        public_id: String,
        #[serde(rename = "systemId")]
        system_id: String,
        source: Value,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompiledAttribute {
    pub name: String,
    pub namespace: Option<String>,
    pub prefix: Option<String>,
    pub value: String,
}

impl CompiledNode {
    pub fn children(&self) -> &[usize] {
        match self {
            Self::Document { children, .. }
            | Self::Fragment { children, .. }
            | Self::Element { children, .. } => children,
            _ => &[],
        }
    }

    fn source(&self) -> &Value {
        match self {
            Self::Document { source, .. }
            | Self::Fragment { source, .. }
            | Self::Element { source, .. }
            | Self::Text { source, .. }
            | Self::Comment { source, .. }
            | Self::Doctype { source, .. } => source,
        }
    }
}

impl CompiledUi {
    pub fn from_json(bytes: &[u8]) -> Result<Self, LoadError> {
        if bytes.len() > MAX_IR_BYTES {
            return Err(LoadError::Limit("serialized IR bytes"));
        }
        let input: Self = serde_json::from_slice(bytes).map_err(LoadError::Json)?;
        input.validate()?;
        Ok(input)
    }

    pub fn validate(&self) -> Result<(), LoadError> {
        if self.format != FORMAT || self.version != VERSION {
            return Err(LoadError::Unsupported("format or version"));
        }
        if self.document.mode != "no-quirks" {
            return Err(LoadError::Unsupported(
                "native document mode other than no-quirks",
            ));
        }
        if self.document.scripting_enabled {
            return Err(LoadError::Unsupported(
                "scripting-enabled initial HTML parsing",
            ));
        }
        bounded_string(&self.source.name)?;
        if self.source.byte_length > MAX_SOURCE_BYTES {
            return Err(LoadError::Limit("source bytes"));
        }
        if self.source.sha256.len() != 64
            || !self
                .source
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(LoadError::Invalid("source SHA-256 syntax"));
        }
        if self.nodes.is_empty() || self.nodes.len() > MAX_NODES {
            return Err(LoadError::Limit("node count"));
        }
        if self.diagnostics.len() > 1000 {
            return Err(LoadError::Limit("diagnostic count"));
        }
        if self.diagnostics_total < self.diagnostics.len()
            || self.diagnostics_truncated != (self.diagnostics_total > self.diagnostics.len())
        {
            return Err(LoadError::Invalid("diagnostic truncation metadata"));
        }
        let mut attributes = 0usize;
        for node in &self.nodes {
            if let CompiledNode::Element {
                attributes: values, ..
            } = node
            {
                attributes += values.len();
                if attributes > MAX_ATTRIBUTES {
                    return Err(LoadError::Limit("total attributes"));
                }
            }
        }
        for diagnostic in &self.diagnostics {
            bounded_metadata(diagnostic)?;
        }
        let CompiledNode::Document { children, .. } = &self.nodes[0] else {
            return Err(LoadError::Invalid("node zero must be the document"));
        };
        let mut elements = 0;
        let mut doctypes = 0;
        for &child in children {
            match self.nodes.get(child) {
                Some(CompiledNode::Element {
                    name, namespace, ..
                }) if name == "html" && namespace == HTML_NAMESPACE => elements += 1,
                Some(CompiledNode::Doctype { .. }) if elements == 0 => doctypes += 1,
                Some(CompiledNode::Comment { .. }) => (),
                _ => return Err(LoadError::Invalid("invalid document child")),
            }
        }
        if elements != 1 || doctypes > 1 {
            return Err(LoadError::Invalid(
                "document must have one HTML root and at most one doctype",
            ));
        }
        // Every edge must visit the next preorder index. This excludes cycles,
        // duplicate ownership, unreachable nodes and arbitrary native handles.
        let mut next = 0;
        self.visit(0, 0, false, &mut next)?;
        if next != self.nodes.len() {
            return Err(LoadError::Invalid("unreachable nodes"));
        }
        Ok(())
    }

    fn visit(
        &self,
        index: usize,
        depth: usize,
        template_fragment: bool,
        next: &mut usize,
    ) -> Result<(), LoadError> {
        if depth > MAX_DEPTH {
            return Err(LoadError::Limit("tree depth"));
        }
        if index != *next {
            return Err(LoadError::Invalid(
                "nodes must have unique preorder ownership",
            ));
        }
        let node = self
            .nodes
            .get(index)
            .ok_or(LoadError::Invalid("node reference out of range"))?;
        *next += 1;
        bounded_metadata(node.source())?;
        if matches!(node, CompiledNode::Fragment { .. }) != template_fragment {
            return Err(LoadError::Invalid(
                "fragment must be owned by an HTML template",
            ));
        }
        match node {
            CompiledNode::Document { .. } if index != 0 => {
                return Err(LoadError::Invalid("nested document"));
            }
            CompiledNode::Element {
                name,
                namespace,
                prefix,
                attributes,
                children,
                template_contents,
                ..
            } => {
                qualified_name(name, namespace, prefix.as_deref())?;
                let mut seen = HashSet::new();
                for attribute in attributes {
                    qualified_name(
                        &attribute.name,
                        attribute.namespace.as_deref().unwrap_or(""),
                        attribute.prefix.as_deref(),
                    )?;
                    bounded_string(&attribute.value)?;
                    if !seen.insert((
                        attribute.namespace.as_deref().unwrap_or(""),
                        attribute.name.as_str(),
                    )) {
                        return Err(LoadError::Invalid("duplicate expanded attribute name"));
                    }
                }
                let is_template = name == "template" && namespace == HTML_NAMESPACE;
                if is_template != template_contents.is_some()
                    || (is_template && !children.is_empty())
                {
                    return Err(LoadError::Invalid(
                        "HTML template requires only an inert contents fragment",
                    ));
                }
                if let Some(contents) = template_contents {
                    self.visit(*contents, depth + 1, true, next)?;
                }
            }
            CompiledNode::Text { value, .. } | CompiledNode::Comment { value, .. } => {
                bounded_string(value)?
            }
            CompiledNode::Doctype {
                name,
                public_id,
                system_id,
                ..
            } => {
                if depth != 1 {
                    return Err(LoadError::Invalid("doctype outside document"));
                }
                for value in [name, public_id, system_id] {
                    bounded_string(value)?;
                }
            }
            _ => (),
        }
        for &child in node.children() {
            self.visit(child, depth + 1, false, next)?;
        }
        Ok(())
    }
}

fn bounded_string(value: &str) -> Result<(), LoadError> {
    if value.len() > MAX_STRING_BYTES {
        Err(LoadError::Limit("individual UTF-8 string"))
    } else {
        Ok(())
    }
}

fn qualified_name(name: &str, namespace: &str, prefix: Option<&str>) -> Result<(), LoadError> {
    for value in [Some(name), Some(namespace), prefix].into_iter().flatten() {
        bounded_string(value)?;
    }
    if name.is_empty()
        || name.contains('\0')
        || prefix.is_some_and(|p| p.contains('\0') || namespace.is_empty())
    {
        return Err(LoadError::Invalid("qualified name"));
    }
    Ok(())
}

fn bounded_metadata(value: &Value) -> Result<(), LoadError> {
    let mut pending = vec![(value, 0)];
    while let Some((value, depth)) = pending.pop() {
        if depth > MAX_DEPTH {
            return Err(LoadError::Limit("metadata depth"));
        }
        match value {
            Value::String(value) => bounded_string(value)?,
            Value::Array(values) => pending.extend(values.iter().map(|value| (value, depth + 1))),
            Value::Object(values) => {
                for (key, value) in values {
                    bounded_string(key)?;
                    pending.push((value, depth + 1));
                }
            }
            _ => (),
        }
    }
    Ok(())
}
