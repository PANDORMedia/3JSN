use std::collections::HashSet;

use blitz_dom::paint_ownership::{
    PaintContextKind, PaintOwnershipIssue, PaintOwnershipPlan, PaintPhase,
};
use blitz_dom::{BaseDocument, DocumentConfig, NodeId, qual_name};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};

fn document(body: &str) -> BaseDocument {
    HtmlDocument::from_html(
        &format!(
            "<html style='margin:0'><body id='body' style='margin:0;width:448px;height:256px'>{body}</body></html>"
        ),
        DocumentConfig {
            viewport: Some(Viewport::new(448, 256, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    )
    .into_inner()
}

fn style(doc: &mut BaseDocument, node: NodeId, css: &str) {
    doc.mutate().set_attribute(node, qual_name!("style"), css);
}

fn selected(plan: &PaintOwnershipPlan<'_>, owner: NodeId, ids: &[NodeId]) -> Vec<NodeId> {
    plan.children(owner)
        .map(|entry| entry.node)
        .filter(|id| ids.contains(id))
        .collect()
}

fn assert_unique(plan: &PaintOwnershipPlan<'_>) {
    let ids: HashSet<_> = plan.entries().iter().map(|entry| entry.node).collect();
    assert_eq!(ids.len(), plan.entries().len());
    assert_eq!(
        plan.entries()
            .iter()
            .filter(|entry| entry.paint_owner.is_none())
            .count(),
        1
    );
    for entry in plan.entries() {
        assert!(
            entry.geometry_owner == plan.document().root_node().id
                || ids.contains(&entry.geometry_owner)
        );
        assert!(ids.contains(&entry.real_sc_owner));
        if let Some(owner) = entry.paint_owner {
            assert!(ids.contains(&owner));
            assert_eq!(
                plan.children(owner)
                    .filter(|child| child.node == entry.node)
                    .count(),
                1
            );
        }
    }
}

#[test]
fn ownership_distinguishes_positioned_auto_from_real_zero_and_effect_contexts() {
    let mut doc = document(
        "<div id='group'><div id='normal' style='width:8px;height:8px'></div><div id='subject' style='position:relative;z-index:2;width:40px;height:32px'></div></div><div id='peer' style='position:relative;z-index:0;width:40px;height:32px'></div>",
    );
    let [group, normal, subject, peer] =
        ["group", "normal", "subject", "peer"].map(|name| doc.get_element_by_id(name).unwrap());
    for css in [
        "position:relative",
        "position:absolute",
        "position:relative;z-index:0",
        "position:fixed",
        "position:sticky",
        "position:static;opacity:.5;z-index:99",
        "position:static;clip-path:inset(-20px)",
        "position:relative",
    ] {
        style(&mut doc, group, &format!("{css};width:80px;height:64px"));
        doc.resolve(0.0);
        let root = doc.root_element().id;
        let plan = PaintOwnershipPlan::build(&doc).unwrap();
        let pseudo = css == "position:relative" || css == "position:absolute";
        assert_eq!(
            plan.entry(group).unwrap().context_kind,
            if pseudo {
                PaintContextKind::PositionedAuto
            } else {
                PaintContextKind::StackingContext
            },
            "{css}"
        );
        assert_eq!(
            plan.entry(group).unwrap().phase,
            PaintPhase::Zero,
            "static non-item z-index does not become 99"
        );
        assert_eq!(
            plan.entry(subject).unwrap().paint_owner,
            Some(if pseudo { root } else { group }),
            "{css}"
        );
        assert_eq!(
            plan.entry(subject).unwrap().real_sc_owner,
            if pseudo { root } else { group },
            "{css}"
        );
        assert_eq!(plan.entry(normal).unwrap().paint_owner, Some(group));
        assert_eq!(
            selected(&plan, root, &[group, peer, subject]),
            if pseudo {
                vec![group, peer, subject]
            } else {
                vec![group, peer]
            }
        );
        assert_unique(&plan);
    }
}

#[test]
fn ownership_keeps_viewport_geometry_separate_from_static_opacity_attachment() {
    let mut doc = document(
        "<div id='outer' style='position:relative;left:32px;top:24px;width:180px;height:120px;overflow:hidden'><div id='effect' style='opacity:.5;width:160px;height:100px'><div id='subject' style='position:fixed;left:128px;top:72px;z-index:2;width:80px;height:40px'></div></div></div>",
    );
    let effect = doc.get_element_by_id("effect").unwrap();
    let subject = doc.get_element_by_id("subject").unwrap();
    let outer = doc.get_element_by_id("outer").unwrap();
    for (x, y) in [(32, 24), (64, 48), (32, 24)] {
        doc.mutate()
            .set_style_property(outer, "left", &format!("{x}px"));
        doc.mutate()
            .set_style_property(outer, "top", &format!("{y}px"));
        doc.resolve(0.0);
        let plan = PaintOwnershipPlan::build(&doc).unwrap();
        let entry = plan.entry(subject).unwrap();
        assert_eq!(entry.geometry_owner, doc.root_node().id);
        assert_eq!(entry.paint_owner, Some(effect));
        assert_eq!(entry.real_sc_owner, effect);
        assert_eq!([entry.prefix.x, entry.prefix.y], [-x as f32, -y as f32]);
        let location = doc.get_node(subject).unwrap().final_layout().location;
        assert_eq!((location.x, location.y), (128.0, 72.0));
    }
}

#[test]
fn ownership_uses_current_prefixes_inside_a_declared_identity_transform_context() {
    let mut doc = document(
        "<div id='context' style='transform:translateX(0);width:300px;height:160px'><div id='carrier' style='position:relative;left:24px;top:16px;width:100px;height:80px'><div id='subject' style='position:relative;z-index:2;width:40px;height:30px'></div></div></div>",
    );
    let [context, carrier, subject] =
        ["context", "carrier", "subject"].map(|name| doc.get_element_by_id(name).unwrap());
    for (x, y) in [(24, 16), (80, 48), (24, 16)] {
        doc.mutate()
            .set_style_property(carrier, "left", &format!("{x}px"));
        doc.mutate()
            .set_style_property(carrier, "top", &format!("{y}px"));
        doc.resolve(0.0);
        let plan = PaintOwnershipPlan::build(&doc).unwrap();
        let entry = plan.entry(subject).unwrap();
        assert_eq!(entry.paint_owner, Some(context));
        assert_eq!(entry.geometry_owner, carrier);
        assert_eq!([entry.prefix.x, entry.prefix.y], [x as f32, y as f32]);
    }
}

#[test]
fn ownership_preserves_formatting_order_contents_pseudos_and_out_of_flow_order_zero() {
    let mut doc = document(
        "<style>#group::before,#group::after{content:'';display:block;position:relative;z-index:1;width:20px;height:20px}#group::before{order:-2}#group::after{order:2}</style><div id='group' style='position:relative'><div id='contents' style='display:contents;order:-100'><div id='first' style='position:relative;z-index:1;order:1;width:20px;height:20px'></div></div><div id='absolute' style='position:absolute;z-index:1;order:-999;width:20px;height:20px'></div><div id='last' style='position:relative;z-index:1;order:-1;width:20px;height:20px'></div></div>",
    );
    let [group, contents, first, absolute, last] =
        ["group", "contents", "first", "absolute", "last"]
            .map(|name| doc.get_element_by_id(name).unwrap());
    for display in ["flex", "grid", "flex"] {
        doc.mutate().set_style_property(group, "display", display);
        for absolute_order in ["-999", "999"] {
            doc.mutate()
                .set_style_property(absolute, "order", absolute_order);
            doc.resolve(0.0);
            let before = doc.get_node(group).unwrap().before().unwrap();
            let after = doc.get_node(group).unwrap().after().unwrap();
            let plan = PaintOwnershipPlan::build(&doc).unwrap();
            assert!(plan.entry(contents).is_none());
            assert_eq!(
                selected(
                    &plan,
                    doc.root_element().id,
                    &[before, first, absolute, last, after]
                ),
                [before, last, absolute, first, after]
            );
            assert_unique(&plan);
        }
    }
}

fn legacy_snapshot(doc: &BaseDocument) -> String {
    let mut pending = vec![doc.root_node().id];
    let mut seen = HashSet::new();
    while let Some(id) = pending.pop() {
        if !seen.insert(id) {
            continue;
        }
        let node = doc.get_node(id).unwrap();
        pending.extend(node.children.iter().copied());
        pending.extend(node.anonymous_blocks.iter().copied());
        pending.extend(node.before());
        pending.extend(node.after());
    }
    let mut ids: Vec<_> = seen.into_iter().collect();
    ids.sort_unstable();
    let mut result = String::new();
    for id in ids {
        let node = doc.get_node(id).unwrap();
        if node.element_data().is_none() && id != doc.root_node().id {
            continue;
        }
        result.push_str(&format!(
            "{id:?}:{:?}:{:?}:{:?}",
            node.layout_parent.get(),
            node.paint_children.borrow(),
            node.final_layout()
        ));
        if let Some(context) = &node.stacking_context {
            result.push_str(&format!(
                "{:?}:{:?}",
                context.content_area, context.negative_z_count
            ));
            for child in &context.children {
                result.push_str(&format!(
                    "{:?}:{:?}:{:?}",
                    child.node_id, child.z_index, child.position
                ));
            }
        }
    }
    result
}

#[test]
fn ownership_retains_real_anonymous_boxes_and_rebuilds_after_hide_show_without_list_writes() {
    let mut doc = document(
        "<div id='mixed'>before<span id='inline'>inline</span><div id='subject' style='position:relative;z-index:1;width:40px;height:20px'></div>after</div><div id='peer' style='position:relative;z-index:1;width:20px;height:20px'></div>",
    );
    let [mixed, inline, subject, peer] =
        ["mixed", "inline", "subject", "peer"].map(|name| doc.get_element_by_id(name).unwrap());
    for display in ["block", "none", "block", "none", "block"] {
        doc.mutate().set_style_property(mixed, "display", display);
        doc.resolve(0.0);
        let before = legacy_snapshot(&doc);
        {
            let plan = PaintOwnershipPlan::build(&doc).unwrap();
            assert!(
                plan.entry(inline).is_none(),
                "a non-atomic inline is not a synthetic box"
            );
            assert_eq!(plan.entry(subject).is_some(), display == "block");
            assert!(plan.entry(peer).is_some());
            if display == "block" {
                assert!(
                    plan.entries()
                        .iter()
                        .any(|entry| doc.get_node(entry.node).unwrap().is_anonymous())
                );
            }
            assert_unique(&plan);
        }
        assert_eq!(
            legacy_snapshot(&doc),
            before,
            "planning must not write legacy geometry or paint lists"
        );
    }
}

#[test]
fn ownership_zero_phase_follows_source_reordering_and_restoration() {
    let mut doc = document(
        "<div id='first' style='position:relative;width:40px;height:40px'></div><div id='last' style='position:relative;z-index:0;width:40px;height:40px'></div>",
    );
    let [body, first, last] =
        ["body", "first", "last"].map(|name| doc.get_element_by_id(name).unwrap());
    for moved in [first, last, first, last] {
        doc.mutate().append_children(body, &[moved]);
        doc.resolve(0.0);
        let plan = PaintOwnershipPlan::build(&doc).unwrap();
        assert_eq!(
            selected(&plan, doc.root_element().id, &[first, last]),
            if moved == first {
                vec![last, first]
            } else {
                vec![first, last]
            }
        );
    }
}

#[test]
fn ownership_rejects_unimplemented_will_change_and_float_group_boundaries() {
    for (css, issue) in [
        (
            "will-change:opacity",
            PaintOwnershipIssue::UnsupportedContextStyle,
        ),
        (
            "will-change:view-transition-name",
            PaintOwnershipIssue::UnsupportedContextStyle,
        ),
        ("float:left", PaintOwnershipIssue::UnsupportedFloat),
    ] {
        let mut doc = document(&format!(
            "<div style='position:relative'><div id='group' style='{css};width:80px;height:40px'><div style='position:relative;z-index:2;width:40px;height:20px'></div></div></div><div style='position:relative;z-index:1;width:40px;height:20px'></div>"
        ));
        doc.resolve(0.0);
        let error = PaintOwnershipPlan::build(&doc).unwrap_err();
        assert_eq!(error.node, doc.get_element_by_id("group").unwrap());
        assert_eq!(error.issue, issue, "{css}");
    }
}

#[test]
fn ownership_reports_an_unresolved_root_as_an_error() {
    let doc = BaseDocument::new(DocumentConfig::default());
    let error = PaintOwnershipPlan::build(&doc).unwrap_err();
    assert_eq!(error.node, doc.root_node().id);
    assert_eq!(error.issue, PaintOwnershipIssue::UnresolvedDocument);
}

#[test]
fn ownership_rejects_unrepresented_fragment_and_coordinate_paths() {
    for (html, expected) in [
        (
            "<div><span style='position:relative'>text</span></div>",
            PaintOwnershipIssue::UnsupportedInlineFragment,
        ),
        (
            "<div><span style='opacity:.5'>text</span></div>",
            PaintOwnershipIssue::UnsupportedInlineFragment,
        ),
        (
            "<div style='transform:rotateY(30deg);width:80px;height:40px'></div>",
            PaintOwnershipIssue::UnsupportedTransform,
        ),
        (
            "<div style='transform:scale(0);width:80px;height:40px'></div>",
            PaintOwnershipIssue::UnsupportedTransform,
        ),
        (
            "<div style='isolation:isolate;width:80px;height:40px'></div>",
            PaintOwnershipIssue::UnsupportedContextStyle,
        ),
    ] {
        let mut doc = document(html);
        doc.resolve(0.0);
        assert_eq!(
            PaintOwnershipPlan::build(&doc).unwrap_err().issue,
            expected,
            "{html}"
        );
    }
    let mut doc = document(
        "<div id='scroller' style='width:80px;height:40px;overflow:auto'><div style='height:200px'></div></div>",
    );
    doc.resolve(0.0);
    let scroller = doc.get_element_by_id("scroller").unwrap();
    doc.get_node_mut(scroller).unwrap().scroll_offset_mut().y = 1.0;
    assert_eq!(
        PaintOwnershipPlan::build(&doc).unwrap_err().issue,
        PaintOwnershipIssue::UnsupportedScroll
    );
}
