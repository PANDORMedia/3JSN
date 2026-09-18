use std::collections::HashSet;

use blitz_dom::{BaseDocument, DocumentConfig, NodeId, QualName, ns, qual_name};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};

fn style(doc: &mut BaseDocument, id: NodeId, css: &str) {
    doc.mutate().set_attribute(id, qual_name!("style"), css);
}

fn fixture() -> (BaseDocument, [NodeId; 4]) {
    let mut doc = HtmlDocument::from_html(
        include_str!("../../../fixtures/paint-order/index.html"),
        DocumentConfig {
            viewport: Some(Viewport::new(448, 256, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    )
    .into_inner();
    for (id, css) in [
        ("body", "margin:0;background:transparent;"),
        (
            "outer",
            "position:relative;left:32px;top:24px;width:320px;height:176px;background:transparent;",
        ),
        ("middle", "position:static;width:280px;height:144px;"),
        ("bridge", "display:none;"),
        (
            "peer",
            "position:absolute;left:40px;top:20px;width:80px;height:64px;z-index:1;",
        ),
        (
            "subject",
            "position:fixed;left:48px;top:40px;width:128px;height:64px;z-index:1;",
        ),
    ] {
        let node = doc.get_element_by_id(id).unwrap();
        style(&mut doc, node, css);
    }
    let ids = ["middle", "bridge", "peer", "subject"].map(|id| doc.get_element_by_id(id).unwrap());
    (doc, ids)
}

// Inspect the resolved lists as stored. The owner may be the document or HTML
// root; this assertion neither selects a new owner nor derives a sort key.
fn assert_stacked_order(doc: &BaseDocument, expected: &[NodeId]) {
    let mut pending = vec![doc.root_node().id];
    let mut seen = HashSet::new();
    let mut lists = Vec::new();
    while let Some(id) = pending.pop() {
        if !seen.insert(id) {
            continue;
        }
        let node = doc.get_node(id).unwrap();
        if let Some(context) = &node.stacking_context {
            let participants: Vec<_> = context
                .children
                .iter()
                .map(|child| child.node_id)
                .filter(|child| expected.contains(child))
                .collect();
            if !participants.is_empty() {
                lists.push(participants);
            }
        }
        pending.extend(node.children.iter().copied());
        pending.extend(node.anonymous_blocks.iter().copied());
        pending.extend(node.before());
        pending.extend(node.after());
    }
    assert_eq!(lists.len(), 1, "participants must share one stacking list");
    assert_eq!(lists[0], expected, "resolved stacking list order");
}

#[test]
fn equal_z_cross_owner_boxes_follow_dom_reordering_for_both_signs() {
    let (mut doc, [middle, _, peer, subject]) = fixture();
    for z_index in ["1", "-1"] {
        for id in [peer, subject] {
            doc.mutate().set_style_property(id, "z-index", z_index);
        }
        for _ in 0..3 {
            doc.mutate().append_children(middle, &[subject]);
            doc.resolve(0.0);
            assert_stacked_order(&doc, &[peer, subject]);
            doc.resolve(0.0);
            assert_stacked_order(&doc, &[peer, subject]);

            doc.mutate().append_children(middle, &[peer]);
            doc.resolve(0.0);
            assert_stacked_order(&doc, &[subject, peer]);
        }
    }
}

#[test]
fn flex_and_grid_equal_z_lists_follow_css_order_and_reset() {
    let (mut doc, [middle, _, peer, subject]) = fixture();
    for display in ["flex", "grid"] {
        style(
            &mut doc,
            middle,
            &format!(
                "display:{display};width:280px;height:144px;grid-template-columns:240px;grid-template-rows:120px;"
            ),
        );
        for id in [peer, subject] {
            style(
                &mut doc,
                id,
                "position:relative;width:128px;height:80px;flex:0 0 auto;grid-area:1/1;order:0;z-index:1;",
            );
        }
        for z_index in ["1", "-1"] {
            for id in [peer, subject] {
                doc.mutate().set_style_property(id, "z-index", z_index);
            }
            for _ in 0..2 {
                for (order, expected) in [
                    ("1", [subject, peer]),
                    ("-1", [peer, subject]),
                    ("0", [peer, subject]),
                ] {
                    doc.mutate().set_style_property(peer, "order", order);
                    doc.resolve(0.0);
                    assert_stacked_order(&doc, &expected);
                    doc.resolve(0.0);
                    assert_stacked_order(&doc, &expected);
                }
            }
        }
    }
}

#[test]
fn out_of_flow_order_values_do_not_reorder_flex_or_grid_paint_children() {
    let (mut doc, [middle, _, peer, subject]) = fixture();
    for display in ["flex", "grid"] {
        style(
            &mut doc,
            middle,
            &format!(
                "position:relative;display:{display};width:280px;height:144px;grid-template-columns:240px;grid-template-rows:120px;"
            ),
        );
        style(
            &mut doc,
            peer,
            "position:relative;width:128px;height:80px;grid-area:1/1;z-index:auto;order:1;",
        );
        style(
            &mut doc,
            subject,
            "position:absolute;left:0;top:0;width:128px;height:80px;z-index:auto;",
        );
        for order in ["-9", "9", "0", "-9"] {
            doc.mutate().set_style_property(subject, "order", order);
            doc.resolve(0.0);
            let children = doc.get_node(middle).unwrap().paint_children.borrow();
            let participants: Vec<_> = children
                .iter()
                .flatten()
                .copied()
                .filter(|id| [peer, subject].contains(id))
                .collect();
            assert_eq!(participants, [subject, peer]);
        }
    }
}

#[test]
fn flattened_contents_children_use_their_own_order_not_the_wrappers() {
    let (mut doc, [middle, bridge, peer, subject]) = fixture();
    doc.mutate().append_children(bridge, &[subject]);
    for display in ["flex", "grid"] {
        style(
            &mut doc,
            middle,
            &format!(
                "display:{display};width:280px;height:144px;grid-template-columns:240px;grid-template-rows:120px;"
            ),
        );
        style(
            &mut doc,
            peer,
            "position:relative;width:128px;height:80px;grid-area:1/1;order:-1;z-index:1;",
        );
        style(
            &mut doc,
            subject,
            "position:relative;width:128px;height:80px;grid-area:1/1;order:1;z-index:1;",
        );
        for wrapper_order in [-100, 100, -100] {
            style(
                &mut doc,
                bridge,
                &format!("display:contents;order:{wrapper_order};"),
            );
            doc.resolve(0.0);
            assert_stacked_order(&doc, &[peer, subject]);
        }
        doc.mutate().set_style_property(subject, "order", "-2");
        doc.resolve(0.0);
        assert_stacked_order(&doc, &[subject, peer]);
    }
}

#[test]
fn empty_before_and_after_boxes_preserve_ties_then_follow_css_order() {
    let (mut doc, [middle, _, peer, subject]) = fixture();
    style(&mut doc, peer, "display:none;");
    style(
        &mut doc,
        middle,
        "display:grid;width:280px;height:144px;grid-template-columns:240px;grid-template-rows:120px;",
    );
    style(
        &mut doc,
        subject,
        "position:relative;grid-area:1/1;width:128px;height:80px;z-index:1;order:0;",
    );
    for mode in ["ties", "flipped", "ties", "flipped", "ties"] {
        doc.mutate().set_attribute(
            middle,
            QualName::new(None, ns!(), "data-pseudos".into()),
            mode,
        );
        doc.resolve(0.0);
        let node = doc.get_node(middle).unwrap();
        let before = node.before().expect("empty ::before box must exist");
        let after = node.after().expect("empty ::after box must exist");
        let expected = if mode == "ties" {
            [before, subject, after]
        } else {
            [after, subject, before]
        };
        assert_stacked_order(&doc, &expected);
    }
}

#[test]
fn relative_descendants_through_anonymous_wrappers_follow_reordered_items() {
    let mut doc = HtmlDocument::from_html(
        r#"<!doctype html>
        <html><body style="margin:0">
          <div id="items" style="width:280px;height:144px;font-size:0;line-height:0">
            <div id="first" style="position:relative;z-index:auto;width:128px;height:80px;grid-area:1/1">
              <span id="peer" style="display:inline-block;position:relative;z-index:1;width:80px;height:64px"></span>
              <div style="width:1px;height:1px"></div>
            </div>
            <div id="second" style="position:relative;z-index:auto;width:128px;height:80px;grid-area:1/1">
              <span id="subject" style="display:inline-block;position:relative;z-index:1;width:80px;height:64px"></span>
              <div style="width:1px;height:1px"></div>
            </div>
          </div>
        </body></html>"#,
        DocumentConfig {
            viewport: Some(Viewport::new(448, 256, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    )
    .into_inner();
    let [items, first, second, peer, subject] = ["items", "first", "second", "peer", "subject"]
        .map(|id| doc.get_element_by_id(id).unwrap());
    for display in ["flex", "grid"] {
        doc.mutate().set_style_property(items, "display", display);
        for z_index in ["1", "-1"] {
            for id in [peer, subject] {
                doc.mutate().set_style_property(id, "z-index", z_index);
            }
            for (order, expected) in [
                ("1", [subject, peer]),
                ("-1", [peer, subject]),
                ("0", [peer, subject]),
            ] {
                doc.mutate().set_style_property(first, "order", order);
                doc.resolve(0.0);
                for (item, descendant) in [(first, peer), (second, subject)] {
                    let item_node = doc.get_node(item).unwrap();
                    let layout_children = item_node.layout_children.borrow();
                    assert!(
                        item_node.anonymous_blocks.iter().any(|id| {
                            let wrapper = doc.get_node(*id).unwrap();
                            wrapper.is_anonymous()
                                && wrapper.children.contains(&descendant)
                                && layout_children.iter().flatten().any(|child| child == id)
                        }),
                        "relative descendant must be inside an actual anonymous layout wrapper"
                    );
                }
                assert_stacked_order(&doc, &expected);
                doc.resolve(0.0);
                assert_stacked_order(&doc, &expected);
            }

            doc.mutate().append_children(items, &[first]);
            doc.resolve(0.0);
            assert_stacked_order(&doc, &[subject, peer]);
            doc.mutate().append_children(items, &[second]);
            doc.resolve(0.0);
            assert_stacked_order(&doc, &[peer, subject]);
        }
    }
}

#[test]
fn detached_stacking_subtree_is_excluded_then_rejoins_resolved_paint_order() {
    let (mut doc, [middle, _, peer, subject]) = fixture();
    let outer = doc.get_element_by_id("outer").unwrap();
    style(
        &mut doc,
        middle,
        "position:relative;z-index:0;width:280px;height:144px;",
    );
    for id in [peer, subject] {
        style(
            &mut doc,
            id,
            "position:relative;z-index:1;width:80px;height:64px;",
        );
    }
    for _ in 0..3 {
        doc.mutate().append_children(middle, &[subject]);
        doc.resolve(0.0);
        assert_stacked_order(&doc, &[peer, subject]);

        doc.mutate().remove_node(middle);
        doc.resolve(0.0);
        assert!(!doc.get_node(middle).unwrap().flags.is_in_document());
        doc.resolve(0.0);

        doc.mutate().append_children(outer, &[middle]);
        doc.resolve(0.0);
        assert_eq!(doc.get_element_by_id("middle"), Some(middle));
        assert_stacked_order(&doc, &[peer, subject]);

        doc.mutate().append_children(middle, &[peer]);
        doc.resolve(0.0);
        assert_stacked_order(&doc, &[subject, peer]);
    }
}

#[test]
fn hiding_mixed_content_releases_anonymous_wrappers_without_breaking_other_paint_lists() {
    let mut doc = HtmlDocument::from_html(
        r#"<!doctype html>
        <html><body style="margin:0">
          <div id="mixed" style="width:160px;font-size:0;line-height:0">
            <span id="retained-span" style="display:inline-block;width:80px;height:24px"></span>
            <div id="retained-block" style="width:80px;height:24px"></div>
          </div>
          <div id="unrelated" style="position:relative;z-index:0;width:160px;height:80px">
            <div id="earlier" style="position:relative;z-index:1;width:40px;height:24px"></div>
            <div id="later" style="position:relative;z-index:1;width:40px;height:24px"></div>
          </div>
        </body></html>"#,
        DocumentConfig {
            viewport: Some(Viewport::new(448, 256, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    )
    .into_inner();
    let [mixed, span, block, earlier, later] = [
        "mixed",
        "retained-span",
        "retained-block",
        "earlier",
        "later",
    ]
    .map(|id| doc.get_element_by_id(id).unwrap());
    let anonymous_wrapper = |doc: &BaseDocument| {
        let node = doc.get_node(mixed).unwrap();
        let layout_children = node.layout_children.borrow();
        node.anonymous_blocks
            .iter()
            .copied()
            .find(|id| {
                let wrapper = doc.get_node(*id).unwrap();
                wrapper.is_anonymous()
                    && wrapper.children.contains(&span)
                    && layout_children.iter().flatten().any(|child| child == id)
            })
            .expect("mixed inline/block content must create a real anonymous wrapper")
    };

    for _ in 0..3 {
        doc.resolve(0.0);
        let old_wrapper = anonymous_wrapper(&doc);
        assert_stacked_order(&doc, &[earlier, later]);

        doc.mutate().set_style_property(mixed, "display", "none");
        doc.resolve(0.0);
        assert!(doc.get_node(old_wrapper).is_none());
        for (name, id) in [("retained-span", span), ("retained-block", block)] {
            assert_eq!(doc.get_element_by_id(name), Some(id));
            assert!(doc.get_node(id).unwrap().flags.is_in_document());
            assert_eq!(doc.get_node(id).unwrap().parent, Some(mixed));
        }
        assert_stacked_order(&doc, &[earlier, later]);
        doc.resolve(0.0);
        assert_stacked_order(&doc, &[earlier, later]);

        doc.mutate().set_style_property(mixed, "display", "block");
        doc.resolve(0.0);
        anonymous_wrapper(&doc);
        assert_eq!(doc.get_element_by_id("retained-span"), Some(span));
        assert_eq!(doc.get_element_by_id("retained-block"), Some(block));
        assert_stacked_order(&doc, &[earlier, later]);
    }
}
