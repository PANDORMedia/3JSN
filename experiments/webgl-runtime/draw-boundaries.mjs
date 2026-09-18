const { createContext, closeContext, observeFrame } = globalThis.__webglHost;
function check(value, message) { if (!value) throw new Error(message); }
const gl = createContext({}, 32, 32);
function shader(type, source) {
  const object = gl.createShader(type); gl.shaderSource(object, source); gl.compileShader(object);
  check(gl.getShaderParameter(object, gl.COMPILE_STATUS), gl.getShaderInfoLog(object));
  return object;
}
const vertex = shader(gl.VERTEX_SHADER, '#version 300 es\nin vec2 position; uniform mat4 transform; void main(){gl_Position=transform*vec4(position,0.,1.);}');
const fragment = shader(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float; uniform vec4 tint; uniform ivec4 delta; out vec4 color; void main(){color=tint+vec4(delta)*0.01;}');
function program() {
  const value = gl.createProgram(); gl.attachShader(value, vertex); gl.attachShader(value, fragment);
  gl.bindAttribLocation(value, 0, 'position'); gl.linkProgram(value);
  check(gl.getProgramParameter(value, gl.LINK_STATUS), gl.getProgramInfoLog(value)); return value;
}
const firstProgram = program(), otherProgram = program();
gl.useProgram(firstProgram);
let tint = gl.getUniformLocation(firstProgram, 'tint');
let transform = gl.getUniformLocation(firstProgram, 'transform');
const identity = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
gl.uniformMatrix4fv(transform, false, identity); gl.uniform4f(tint, 1, 0, 0, 1);
const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
const vertices = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
const source = new Float32Array([999,999, -.8,-.8, .8,-.8, 0,.8, 999,999]);
gl.bufferData(gl.ARRAY_BUFFER, source.subarray(2, 8), gl.DYNAMIC_DRAW);
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
const indices = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([99,0,1,2,99]), gl.STATIC_DRAW, 1, 3);
function draw() {
  gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawElements(gl.TRIANGLES, 3, gl.UNSIGNED_SHORT, 0);
}
function pixels() { const bytes = new Uint8Array(32 * 32 * 4); observeFrame(gl, bytes); return bytes; }
function error(expected, message) { check(gl.getError() === expected, message); check(gl.getError() === gl.NO_ERROR, 'Unexpected second error'); }
draw(); error(gl.NO_ERROR, 'Valid indexed draw failed');
const baseline = pixels(), center = (16 * 32 + 16) * 4;
check(baseline[center] === 255 && baseline[center + 1] === 0, 'Valid triangle missing');
const delta = gl.getUniformLocation(firstProgram, 'delta');
gl.uniform4iv(delta, new Int32Array([99,-10,0,0,0,99]).subarray(1,5));
draw(); error(gl.NO_ERROR, 'Signed integer uniform upload failed');
check(Math.abs(pixels()[center] - 230) <= 1, 'Signed integer view bits or offsets changed');
gl.uniform4iv(delta, new Int32Array(4)); draw(); error(gl.NO_ERROR, 'Restored integer uniform failed');
gl.drawElements(gl.TRIANGLES, 4, gl.UNSIGNED_SHORT, 0); error(gl.INVALID_OPERATION, 'EBO overrun accepted');
check(pixels().every((x,i) => x === baseline[i]), 'Rejected EBO draw changed framebuffer');
gl.bufferSubData(gl.ARRAY_BUFFER, 20, new Float32Array([1,2])); error(gl.INVALID_VALUE, 'SubData overrun accepted');
gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array([99,99, 2,2, 3,2, 2,3, 99]), 2, 6);
draw(); error(gl.NO_ERROR, 'Source-offset update failed');
check(pixels()[center] === 0, 'bufferSubData did not update GPU geometry');
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0]), gl.STATIC_DRAW);
gl.drawElements(gl.TRIANGLES, 3, gl.UNSIGNED_SHORT, 0); error(gl.INVALID_OPERATION, 'Undersized enabled VBO accepted');
gl.bindBuffer(gl.ARRAY_BUFFER, null);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); error(gl.INVALID_OPERATION, 'Client-memory attribute pointer accepted');
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
gl.drawElements(gl.TRIANGLES, 3, gl.UNSIGNED_SHORT, 0); error(gl.INVALID_OPERATION, 'Client-memory index pointer accepted');
gl.useProgram(otherProgram); gl.uniform4f(tint, 0,1,0,1); error(gl.INVALID_OPERATION, 'Foreign-current-program location accepted');
gl.useProgram(firstProgram);
gl.uniformMatrix4fv(transform, true, identity); error(gl.INVALID_VALUE, 'Transpose accepted');
gl.uniformMatrix4fv(transform, false, identity.subarray(0,15)); error(gl.INVALID_VALUE, 'Incomplete matrix accepted');
for (const invalid of [1000000000, new ArrayBuffer(16)]) {
  let rejected = false;
  try { gl.uniform4fv(tint, invalid); } catch (error) { rejected = error instanceof TypeError; }
  check(rejected, 'Non-sequence uniform input accepted');
}
const reentrant = { *[Symbol.iterator]() { gl.useProgram(otherProgram); yield 1; yield 0; yield 0; yield 1; } };
gl.uniform4fv(tint, reentrant); error(gl.INVALID_OPERATION, 'Uniform coercion bypassed current program validation');
gl.useProgram(firstProgram);
gl.linkProgram(firstProgram); gl.useProgram(firstProgram);
gl.uniform4f(tint, 0,1,0,1); error(gl.INVALID_OPERATION, 'Stale location survived relink');
tint = gl.getUniformLocation(firstProgram, 'tint'); transform = gl.getUniformLocation(firstProgram, 'transform');
gl.uniform4f(tint, 0,1,0,1); gl.uniformMatrix4fv(transform, false, identity); error(gl.NO_ERROR, 'Fresh relink locations failed');
gl.deleteProgram(firstProgram);
gl.uniform4f(tint, 1, 0, 1, 1); error(gl.NO_ERROR, 'Deleted current program lost its pending lifetime');
gl.useProgram(null);
gl.uniform4f(tint, 1, 0, 1, 1); error(gl.INVALID_OPERATION, 'Deleted program survived unbinding');
gl.deleteVertexArray(vao); gl.deleteBuffer(vertices); gl.deleteBuffer(indices);
gl.useProgram(null); gl.deleteProgram(firstProgram); gl.deleteProgram(otherProgram); gl.deleteShader(vertex); gl.deleteShader(fragment);
error(gl.NO_ERROR, 'Cleanup failed'); closeContext(gl);
globalThis.__rendererInitReport = {status:'draw-boundaries-pass', controls: ['typed upload offsets','bufferSubData source ranges','EBO bounds','ANGLE VBO bounds','client-memory pointers rejected','uniform program identity','matrix extents','relink generations']};
