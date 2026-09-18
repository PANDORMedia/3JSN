use blitz_dom::{BaseDocument, DocumentConfig, NodeId};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};

fn occurrences(doc: &BaseDocument, node: NodeId, target: NodeId) -> usize {
    let current = doc.get_node(node).unwrap();
    let normal = current.paint_children.borrow();
    let children = normal.iter().flatten().copied().chain(
        current
            .stacking_context
            .iter()
            .flat_map(|context| context.children.iter().map(|child| child.node_id)),
    );
    usize::from(node == target)
        + children
            .map(|child| occurrences(doc, child, target))
            .sum::<usize>()
}

#[test]
fn stacking_context_transitions_keep_one_paint_owner() {
    let mut doc = HtmlDocument::from_html(
        r#"<style>
        #parent {position:absolute; width:200px; height:100px;}
        #canvas, #box {position:absolute; width:40px; height:40px;}
        #canvas {z-index:2;} #box {z-index:-1;}
        </style><div id="parent"><canvas id="canvas"></canvas><div id="box"></div></div>"#,
        DocumentConfig {
            viewport: Some(Viewport::new(320, 200, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    )
    .into_inner();
    let parent = doc.get_element_by_id("parent").unwrap();
    let targets = [
        doc.get_element_by_id("canvas").unwrap(),
        doc.get_element_by_id("box").unwrap(),
    ];
    for _ in 0..4 {
        for value in ["auto", "0", "auto", "-2", "auto", "2"] {
            doc.mutate().set_style_property(parent, "z-index", value);
            doc.resolve(0.0);
            for target in targets {
                assert_eq!(
                    occurrences(&doc, doc.root_element().id, target),
                    1,
                    "{value}: {target:?}"
                );
            }
        }
    }
}
