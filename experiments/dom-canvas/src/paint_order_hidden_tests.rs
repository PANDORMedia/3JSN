use blitz_dom::{BaseDocument, DocumentConfig, NodeId};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};

fn stacking_children(doc: &BaseDocument, host: NodeId) -> Vec<NodeId> {
    doc.get_node(host)
        .unwrap()
        .stacking_context
        .as_ref()
        .unwrap()
        .children
        .iter()
        .map(|child| child.node_id)
        .collect()
}

#[test]
fn retained_hidden_nonzero_z_entry_does_not_mask_active_order_or_break_reshow() {
    let mut doc = HtmlDocument::from_html(
        r#"<html><body style="margin:0">
        <div id="host" style="position:relative;z-index:0">
          <div id="earlier" style="position:relative;z-index:1;width:80px;height:24px"></div>
          <div id="hidden" style="position:relative;z-index:1;width:160px;font-size:0;line-height:0">
            <span style="display:inline-block;width:80px;height:24px"></span>
            <div style="width:80px;height:24px"></div>
          </div>
          <div id="later" style="position:relative;z-index:1;width:80px;height:24px"></div>
        </div></body></html>"#,
        DocumentConfig {
            viewport: Some(Viewport::new(448, 256, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    )
    .into_inner();
    let [host, earlier, hidden, later] =
        ["host", "earlier", "hidden", "later"].map(|id| doc.get_element_by_id(id).unwrap());

    for _ in 0..3 {
        doc.mutate()
            .append_children(host, &[earlier, hidden, later]);
        doc.resolve(0.0);
        assert_eq!(stacking_children(&doc, host), [earlier, hidden, later]);

        doc.mutate().set_style_property(hidden, "display", "none");
        doc.resolve(0.0);
        // Exercise the retained-entry path rather than accidentally passing
        // because the style flush removed the hidden node from this list.
        assert!(stacking_children(&doc, host).contains(&hidden));
        assert_eq!(doc.get_element_by_id("hidden"), Some(hidden));
        let active: Vec<_> = stacking_children(&doc, host)
            .into_iter()
            .filter(|id| *id != hidden)
            .collect();
        assert_eq!(active, [earlier, later]);

        doc.mutate().append_children(host, &[earlier]);
        for _ in 0..2 {
            doc.resolve(0.0);
            let active: Vec<_> = stacking_children(&doc, host)
                .into_iter()
                .filter(|id| *id != hidden)
                .collect();
            assert_eq!(active, [later, earlier]);
        }

        doc.mutate().set_style_property(hidden, "display", "block");
        for _ in 0..2 {
            doc.resolve(0.0);
            assert_eq!(stacking_children(&doc, host), [hidden, later, earlier]);
        }
    }
}

#[test]
fn hidden_entry_keeps_its_slot_and_does_not_gain_origin_hit_priority() {
    let mut doc = HtmlDocument::from_html(
        r#"<html><body style="margin:0">
        <div id="host" style="position:relative;z-index:0;width:160px">
          <div id="hidden" style="position:relative;z-index:1;width:80px;height:24px"></div>
          <div id="earlier" style="position:relative;z-index:1;width:80px;height:24px"></div>
          <div id="later" style="position:relative;z-index:1;width:80px;height:24px"></div>
        </div></body></html>"#,
        DocumentConfig {
            viewport: Some(Viewport::new(448, 256, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    )
    .into_inner();
    let [host, hidden, earlier, later] =
        ["host", "hidden", "earlier", "later"].map(|id| doc.get_element_by_id(id).unwrap());

    for _ in 0..3 {
        doc.mutate()
            .append_children(host, &[hidden, earlier, later]);
        doc.mutate().set_style_property(hidden, "display", "block");
        doc.resolve(0.0);
        assert_eq!(stacking_children(&doc, host), [hidden, earlier, later]);

        doc.mutate().set_style_property(hidden, "display", "none");
        for _ in 0..2 {
            doc.resolve(0.0);
            assert_eq!(
                (
                    stacking_children(&doc, host),
                    doc.element_from_point(0.0, 0.0)
                ),
                (vec![hidden, earlier, later], Some(earlier))
            );
        }

        doc.mutate().append_children(host, &[earlier]);
        for _ in 0..2 {
            doc.resolve(0.0);
            assert_eq!(
                (
                    stacking_children(&doc, host),
                    doc.element_from_point(0.0, 0.0)
                ),
                (vec![hidden, later, earlier], Some(later))
            );
        }
    }
}
