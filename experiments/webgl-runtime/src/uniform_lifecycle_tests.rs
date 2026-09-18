use super::*;
use deno_core::{JsRuntime, RuntimeOptions};

fn count(runtime: &JsRuntime) -> usize {
    runtime.op_state().borrow().borrow::<State>().objects.len()
}

#[test]
#[ignore = "Requires ANGLE_LIBRARY_DIR and native Metal hardware"]
fn uniform_registry_tracks_live_program_generations() -> Result<(), Box<dyn std::error::Error>> {
    let executor = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()?;
    let _entered = executor.enter();
    let libraries = std::env::var("ANGLE_LIBRARY_DIR")?;
    let mut runtime = JsRuntime::new(RuntimeOptions {
        extensions: vec![probe_extension(Path::new(&libraries))?],
        ..Default::default()
    });
    runtime.execute_script("uniform:fixture", include_str!("uniform-lifecycle-test.js"))?;
    assert_eq!(count(&runtime), 3, "two shaders and one program");
    runtime.execute_script(
        "uniform:lookup",
        r#"
        globalThis.first = gl.getUniformLocation(program, 'tint');
        globalThis.second = gl.getUniformLocation(program, 'tint[1]');
        const retained = [];
        for (let i = 0; i < 4096; i++) {
          const alias = gl.getUniformLocation(program, i % 2 ? 'tint[0]' : 'tint');
          check(alias !== first, 'Uniform lookup must return a fresh wrapper');
          retained.push(alias);
          check(gl.getUniformLocation(program, 'missing' + i) === null, 'Missing uniform found');
        }
        gl.uniform4f(first, 1, 0, 0, 1);
        gl.uniform4f(second, 0, 0, 0, 0);
        draw(gl, [255, 0, 0, 255]);
    "#,
    )?;
    assert_eq!(
        count(&runtime),
        5,
        "aliases and misses must not allocate native entries"
    );
    runtime.execute_script(
        "uniform:foreign",
        r#"
        globalThis.other = __webglHost.createContext({}, 8, 8);
        const foreign = makeProgram(other);
        const foreignLocation = other.getUniformLocation(foreign.program, 'tint');
        other.uniform4f(foreignLocation, 0, 0, 1, 1);
        draw(other, [0, 0, 255, 255]);
        other.uniform4f(first, 0, 1, 0, 1);
        check(other.getError() === other.INVALID_OPERATION, 'Foreign location accepted');
        __webglHost.closeContext(other);
        draw(gl, [255, 0, 0, 255]);
    "#,
    )?;
    assert_eq!(
        count(&runtime),
        5,
        "other-context teardown must preserve this context"
    );

    for iteration in 0..64 {
        runtime.execute_script(
            "uniform:relink",
            r#"
            gl.linkProgram(program);
            check(gl.getProgramParameter(program, gl.LINK_STATUS), 'Relink failed');
            gl.uniform4f(first, 0, 0, 1, 1);
            check(gl.getError() === gl.INVALID_OPERATION, 'Stale location survived relink');
        "#,
        )?;
        assert_eq!(
            count(&runtime),
            3,
            "link {iteration} must reclaim old locations"
        );
        runtime.execute_script(
            "uniform:new-generation",
            r#"
            first = gl.getUniformLocation(program, 'tint[0]');
            second = gl.getUniformLocation(program, 'tint[1]');
            gl.uniform4f(first, 1, 0, 0, 1);
            draw(gl, [255, 0, 0, 255]);
        "#,
        )?;
        assert_eq!(
            count(&runtime),
            5,
            "live locations must stay bounded across relinks"
        );
    }
    runtime.execute_script(
        "uniform:failed-link",
        r#"
        gl.shaderSource(fragment, 'this is invalid GLSL');
        gl.compileShader(fragment);
        gl.linkProgram(program);
        check(!gl.getProgramParameter(program, gl.LINK_STATUS), 'Invalid shader linked');
        gl.uniform4f(first, 0, 0, 1, 1);
        check(gl.getError() === gl.INVALID_OPERATION, 'Failed link retained stale locations');
        check(gl.getUniformLocation(program, 'tint') === null, 'Failed program exposed locations');
        check(gl.getError() === gl.INVALID_OPERATION, 'Failed lookup lost GL error');
    "#,
    )?;
    assert_eq!(
        count(&runtime),
        3,
        "failed links must also reclaim locations"
    );
    runtime.execute_script(
        "uniform:deleted-current",
        r#"
        gl.shaderSource(fragment, fragmentSource);
        gl.compileShader(fragment);
        gl.linkProgram(program);
        check(gl.getProgramParameter(program, gl.LINK_STATUS), 'Recovery link failed');
        gl.useProgram(program);
        first = gl.getUniformLocation(program, 'tint');
        gl.deleteProgram(program);
        gl.uniform4f(first, 0, 1, 0, 1);
        draw(gl, [0, 255, 0, 255]);
        const unlinked = gl.createProgram();
        gl.useProgram(unlinked);
        check(gl.getError() === gl.INVALID_OPERATION, 'Unlinked program became current');
        gl.deleteProgram(unlinked);
        gl.uniform4f(first, 0, 0, 1, 1);
        draw(gl, [0, 0, 255, 255]);
    "#,
    )?;
    assert_eq!(
        count(&runtime),
        3,
        "deleted current executable must retain its location"
    );
    runtime.execute_script(
        "uniform:unbind",
        r#"
        gl.useProgram(null);
        gl.uniform4f(first, 1, 1, 0, 1);
        check(gl.getError() === gl.INVALID_OPERATION, 'Deleted/unbound location survived');
    "#,
    )?;
    assert_eq!(
        count(&runtime),
        2,
        "successful unbind must release deleted program locations"
    );
    runtime.execute_script(
        "uniform:delete-noncurrent",
        r#"
        const fresh = makeProgram(gl);
        const location = gl.getUniformLocation(fresh.program, 'tint');
        gl.useProgram(null);
        gl.deleteProgram(fresh.program);
        gl.uniform4f(location, 1, 1, 0, 1);
        check(gl.getError() === gl.INVALID_OPERATION, 'Noncurrent deleted location survived');
    "#,
    )?;
    assert_eq!(count(&runtime), 4, "only the four shader wrappers remain");
    runtime.execute_script(
        "uniform:before-direct-switch",
        r#"
        const retiring = makeProgram(gl);
        globalThis.retiringLocation = gl.getUniformLocation(retiring.program, 'tint');
        gl.deleteProgram(retiring.program);
        gl.uniform4f(retiringLocation, 1, 0, 0, 1);
        draw(gl, [255, 0, 0, 255]);
    "#,
    )?;
    assert_eq!(
        count(&runtime),
        7,
        "six shaders and the deleted-current location"
    );
    runtime.execute_script("uniform:direct-switch", r#"
        const replacement = makeProgram(gl);
        const replacementLocation = gl.getUniformLocation(replacement.program, 'tint');
        gl.uniform4f(retiringLocation, 0, 0, 1, 1);
        check(gl.getError() === gl.INVALID_OPERATION, 'Direct program switch retained stale location');
        gl.uniform4f(replacementLocation, 1, 1, 0, 1);
        draw(gl, [255, 255, 0, 255]);
    "#)?;
    assert_eq!(
        count(&runtime),
        10,
        "eight shaders, one live program and one location"
    );
    release_all(&mut runtime)?;
    assert_eq!(
        count(&runtime),
        0,
        "context teardown must release every entry"
    );
    println!(
        "Uniform lifecycle: 4096 alias/missing lookups, 64 relinks, failed link, deleted-current/failed-switch/unbind, noncurrent delete, foreign context and final zero registry passed"
    );
    Ok(())
}
