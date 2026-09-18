use std::{error::Error, fs};

use blitz_dom::{BaseDocument, DocumentConfig, NodeId, paint_ownership::PaintOwnershipPlan};
use blitz_traits::shell::{ColorScheme, Viewport};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[allow(
    dead_code,
    reason = "Reuse the authoritative DOM ops without prior scenarios."
)]
#[path = "dom_diagnostic_host.rs"]
mod dom;

#[derive(Deserialize)]
struct Case {
    name: String,
    #[serde(default = "default_scale")]
    scale: f32,
}

fn default_scale() -> f32 {
    1.0
}

fn node_reference(doc: &BaseDocument, id: NodeId) -> Value {
    json!({
        "node": id.as_u64(),
        "elementId": doc.get_node(id).and_then(|node| node.element_data())
            .and_then(|element| element.attr(blitz_dom::qual_name!("id").local)),
    })
}

fn ownership(doc: &BaseDocument) -> Value {
    let plan = match PaintOwnershipPlan::build(doc) {
        Ok(plan) => plan,
        Err(error) => {
            return json!({
                "status": "unsupported", "node": node_reference(doc, error.node),
                "issue": format!("{:?}", error.issue), "message": error.to_string(),
            });
        }
    };
    let entries: Vec<_> = plan.entries().iter().map(|entry| {
        let node = doc.get_node(entry.node).expect("plan contains live nodes");
        let layout = node.final_layout();
        let legacy_normal: Vec<_> = node.paint_children.borrow().iter().flatten()
            .map(|id| node_reference(doc, *id)).collect();
        let legacy_hoisted: Vec<_> = node.stacking_context.as_ref().into_iter()
            .flat_map(|context| &context.children)
            .map(|child| json!({
                "child": node_reference(doc, child.node_id), "zIndex": child.z_index,
                "prefix": {"x": child.position.x, "y": child.position.y},
            })).collect();
        json!({
            "node": node_reference(doc, entry.node),
            "geometryOwner": node_reference(doc, entry.geometry_owner),
            "realContextOwner": node_reference(doc, entry.real_sc_owner),
            "paintOwner": entry.paint_owner.map(|id| node_reference(doc, id)),
            "phase": format!("{:?}", entry.phase), "formattingRank": entry.formatting_rank,
            "contextKind": format!("{:?}", entry.context_kind),
            "prefix": {"x": entry.prefix.x, "y": entry.prefix.y},
            "layout": {"x": layout.location.x, "y": layout.location.y,
                "width": layout.size.width, "height": layout.size.height},
            "children": plan.children(entry.node).map(|child| node_reference(doc, child.node)).collect::<Vec<_>>(),
            "legacy": {"normal": legacy_normal, "hoisted": legacy_hoisted},
        })
    }).collect();
    json!({"status": "collected", "entries": entries})
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 4 {
        return Err(
            "usage: paint-owner-probe <html> <fixture.js> <cases.json> <report.json>".into(),
        );
    }
    let html = fs::read_to_string(&args[0])?;
    let script = fs::read_to_string(&args[1])?;
    let cases_bytes = fs::read(&args[2])?;
    let cases: Vec<Case> = serde_json::from_slice(&cases_bytes)?;
    if cases.is_empty() {
        return Err("at least one paint ownership case is required".into());
    }
    let mut runtime = dom::create(&html, DocumentConfig::default());
    runtime.execute_script("probe:ownership-fixture", script.clone())?;
    let mut reports = Vec::with_capacity(cases.len());
    for case in cases {
        let (width, height) = (448.0 * case.scale, 256.0 * case.scale);
        if case.name.is_empty()
            || ![width, height].iter().all(|value| {
                value.is_finite() && *value >= 1.0 && *value <= 16384.0 && value.fract() == 0.0
            })
        {
            return Err(
                "case requires a name and a positive scale with bounded integral dimensions".into(),
            );
        }
        dom::evaluate::<()>(
            &mut runtime,
            format!(
                "(async () => {{ await clipFixture.prepare({}); }})()",
                serde_json::to_string(&case.name)?,
            ),
        )
        .await?;
        let report = dom::with_document(&mut runtime, |doc| {
            doc.set_viewport(Viewport::new(
                width as u32,
                height as u32,
                case.scale,
                ColorScheme::Light,
            ));
            doc.resolve(0.0);
            ownership(doc)
        });
        reports.push(
            json!({"name": case.name, "scale": case.scale, "explicitResolveCalls": 1, "plan": report}),
        );
    }
    let collected = reports
        .iter()
        .all(|case| case["plan"]["status"] == "collected");
    let hash = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
    let report = json!({
        "schemaVersion": 1, "kind": "native-paint-ownership-diagnostic",
        "status": if collected {"collected"} else {"unsupported"},
        "gpuRequested": false, "planAppliedToLegacyPaintLists": false,
        "v8": deno_core::v8::V8::get_version(), "cases": reports,
        "inputs": {"htmlSha256": hash(html.as_bytes()), "scriptSha256": hash(script.as_bytes()),
            "casesSha256": hash(&cases_bytes)},
        "limits": ["Read-only post-layout box ownership; no rendering or hit-testing change.",
            "Clips, scrolling, fragment effects and unsupported context styles remain adoption gates.",
            "Collection success does not certify pixels, compatibility or performance.",
            "Explicit resolve count excludes geometry reads performed by a supplied fixture; the public fixture performs none."],
    });
    fs::write(
        &args[3],
        format!("{}\n", serde_json::to_string_pretty(&report)?),
    )?;
    println!("{} cases; ownership {}", reports.len(), report["status"]);
    if !collected {
        return Err("PAINT_OWNERSHIP_UNSUPPORTED; report saved".into());
    }
    Ok(())
}
