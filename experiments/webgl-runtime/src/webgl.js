import { installPrograms } from './webgl-programs.js';
import { installGeometry } from './webgl-geometry.js';
import { core } from 'ext:core/mod.js';

// This partial facade is not installed as the browser's WebGL2RenderingContext.
// Unsupported entry points remain absent until their native behavior is implemented.
const constants = {
  ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893,
  STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8, STREAM_DRAW: 0x88e0,
  FLOAT: 0x1406, BYTE: 0x1400, SHORT: 0x1402, UNSIGNED_SHORT: 0x1403,
  INT: 0x1404, UNSIGNED_INT: 0x1405, HALF_FLOAT: 0x140b,
  TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6, POINTS: 0, LINES: 1, LINE_LOOP: 2, LINE_STRIP: 3,
  COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82, VALIDATE_STATUS: 0x8b83, DELETE_STATUS: 0x8b80,
  SHADER_TYPE: 0x8b4f, ATTACHED_SHADERS: 0x8b85, ACTIVE_UNIFORMS: 0x8b86, ACTIVE_ATTRIBUTES: 0x8b89,
  FLOAT_VEC2: 0x8b50, FLOAT_VEC3: 0x8b51, FLOAT_VEC4: 0x8b52,
  INT_VEC2: 0x8b53, INT_VEC3: 0x8b54, INT_VEC4: 0x8b55, BOOL: 0x8b56,
  BOOL_VEC2: 0x8b57, BOOL_VEC3: 0x8b58, BOOL_VEC4: 0x8b59,
  FLOAT_MAT2: 0x8b5a, FLOAT_MAT3: 0x8b5b, FLOAT_MAT4: 0x8b5c,
  SAMPLER_2D: 0x8b5e, SAMPLER_CUBE: 0x8b60,
  ONE: 1, ZERO: 0, SRC_COLOR: 0x300, ONE_MINUS_SRC_COLOR: 0x301,
  SRC_ALPHA: 0x302, ONE_MINUS_SRC_ALPHA: 0x303, DST_ALPHA: 0x304, ONE_MINUS_DST_ALPHA: 0x305,
  DST_COLOR: 0x306, ONE_MINUS_DST_COLOR: 0x307, SRC_ALPHA_SATURATE: 0x308,
  CONSTANT_COLOR: 0x8001, ONE_MINUS_CONSTANT_COLOR: 0x8002,
  CONSTANT_ALPHA: 0x8003, ONE_MINUS_CONSTANT_ALPHA: 0x8004, BLEND_COLOR: 0x8005,
  FUNC_ADD: 0x8006, MIN: 0x8007, MAX: 0x8008, FUNC_SUBTRACT: 0x800a, FUNC_REVERSE_SUBTRACT: 0x800b,
  BLEND_EQUATION: 0x8009, BLEND_EQUATION_RGB: 0x8009, BLEND_EQUATION_ALPHA: 0x883d,
  BLEND_DST_RGB: 0x80c8, BLEND_SRC_RGB: 0x80c9, BLEND_DST_ALPHA: 0x80ca, BLEND_SRC_ALPHA: 0x80cb,
  POLYGON_OFFSET_FILL: 0x8037, SAMPLE_ALPHA_TO_COVERAGE: 0x809e,

  NO_ERROR: 0, INVALID_ENUM: 0x500, INVALID_VALUE: 0x501, INVALID_OPERATION: 0x502,
  COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x100, STENCIL_BUFFER_BIT: 0x400,
  VENDOR: 0x1f00, RENDERER: 0x1f01, VERSION: 0x1f02, SHADING_LANGUAGE_VERSION: 0x8b8c,
  VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
  LOW_FLOAT: 0x8df0, MEDIUM_FLOAT: 0x8df1, HIGH_FLOAT: 0x8df2,
  LOW_INT: 0x8df3, MEDIUM_INT: 0x8df4, HIGH_INT: 0x8df5,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d, MAX_TEXTURE_SIZE: 0xd33,
  MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c, MAX_VERTEX_ATTRIBS: 0x8869,
  MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb, MAX_VARYING_VECTORS: 0x8dfc,
  MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd, MAX_SAMPLES: 0x8d57, SAMPLES: 0x80a9,
  MAX_UNIFORM_BUFFER_BINDINGS: 0x8a2f, SCISSOR_BOX: 0xc10, VIEWPORT: 0xba2,
  TEXTURE_2D: 0xde1, TEXTURE_3D: 0x806f, TEXTURE_2D_ARRAY: 0x8c1a,
  TEXTURE_CUBE_MAP: 0x8513, TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515,
  TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, TEXTURE_WRAP_R: 0x8072,
  NEAREST: 0x2600, LINEAR: 0x2601, CLAMP_TO_EDGE: 0x812f, REPEAT: 0x2901,
  RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, DEPTH_TEST: 0xb71, CULL_FACE: 0xb44,
  BLEND: 0xbe2, SCISSOR_TEST: 0xc11, STENCIL_TEST: 0xb90,
  NEVER: 0x200, LESS: 0x201, EQUAL: 0x202, LEQUAL: 0x203, GREATER: 0x204,
  NOTEQUAL: 0x205, GEQUAL: 0x206, ALWAYS: 0x207,
  CW: 0x900, CCW: 0x901, FRONT: 0x404, BACK: 0x405, FRONT_AND_BACK: 0x408,
  FRAMEBUFFER: 0x8d40, READ_FRAMEBUFFER: 0x8ca8, DRAW_FRAMEBUFFER: 0x8ca9,
};
const objects = new WeakMap();
const contexts = new WeakMap();
function state(receiver) {
  const value = contexts.get(receiver);
  if (!value) throw new TypeError('Illegal WebGL receiver');
  if (value.closed) throw new TypeError('Disposed experimental WebGL context');
  return value;
}
function resource(receiver, object, kind) {
  const owner = state(receiver);
  if (object === null) return 0;
  const value = objects.get(object);
  if (!value || value.kind !== kind) throw new TypeError(`Expected ${kind}`);
  if (value.owner !== owner || value.deleted) {
    owner.errors.add(constants.INVALID_OPERATION);
    return undefined;
  }
  return value.id;
}
function create(receiver, kind, op) {
  const owner = state(receiver);
  const object = Object.freeze(Object.create(null));
  objects.set(object, { owner, kind, id: op(owner.id), deleted: false });
  return object;
}
function remove(receiver, object, kind, op) {
  if (object === null) return;
  const value = objects.get(object);
  if (value?.owner === state(receiver) && value.kind === kind && value.deleted) return;
  const id = resource(receiver, object, kind);
  if (id === undefined) return;
  op(state(receiver).id, id);
  value.deleted = true;
}

export class ExperimentalWebGLContext {
  constructor(canvas, width, height) {
    if (![width, height].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 16384)) {
      throw new RangeError('Experimental drawing buffer dimensions must be integers from 1 to 16384');
    }
    const id = core.ops.op_angle_create(width, height);
    contexts.set(this, { id, canvas, width, height, closed: false, errors: new Set() });
  }
  get canvas() { return state(this).canvas; }
  get drawingBufferWidth() { return state(this).width; }
  get drawingBufferHeight() { return state(this).height; }
  getContextAttributes() {
    state(this);
    // These are the native configuration's actual attributes, not requested hints.
    return { alpha: true, depth: true, stencil: true, antialias: false,
      premultipliedAlpha: true, preserveDrawingBuffer: true,
      powerPreference: 'default', failIfMajorPerformanceCaveat: false, desynchronized: false };
  }
  getSupportedExtensions() { state(this); return []; }
  getExtension(name) { state(this); String(name); return null; }
  getError() {
    const owner = state(this);
    // Synthetic validation and ANGLE contribute to one set of outstanding flags.
    // Bound the drain defensively for a backend that repeats a context-loss error.
    for (let count = 0; count < 16; count++) {
      const error = core.ops.op_gl_get_error(owner.id);
      if (error === constants.NO_ERROR) break;
      owner.errors.add(error);
    }
    const error = owner.errors.values().next().value;
    if (error !== undefined) { owner.errors.delete(error); return error; }
    return constants.NO_ERROR;
  }
  getParameter(parameter) {
    const result = core.ops.op_gl_get_parameter(state(this).id, parameter >>> 0);
    switch (result.kind) {
      case 'int32-array': return new Int32Array(result.value);
      case 'float32-array': return new Float32Array(result.value);
      default: return result.value;
    }
  }
  getShaderPrecisionFormat(shader, precision) {
    return core.ops.op_gl_get_shader_precision_format(state(this).id, shader >>> 0, precision >>> 0);
  }
  createTexture() { return create(this, 'texture', core.ops.op_gl_create_texture); }
  bindTexture(target, texture) {
    const id = resource(this, texture, 'texture');
    if (id !== undefined) core.ops.op_gl_bind_texture(state(this).id, target >>> 0, id);
  }
  deleteTexture(texture) { remove(this, texture, 'texture', core.ops.op_gl_delete_texture); }
  texParameteri(target, pname, value) {
    core.ops.op_gl_tex_parameteri(state(this).id, target >>> 0, pname >>> 0, value | 0);
  }
  texImage2D(target, level, internalFormat, width, height, border, format, type, data) {
    const owner = state(this);
    if (arguments.length !== 9) throw new TypeError('Only the sized typed-array texImage2D overload is implemented');
    if (data !== null && !(data instanceof Uint8Array)) throw new TypeError('Expected Uint8Array or null');
    const error = core.ops.op_gl_tex_image_2d(owner.id, target >>> 0, level | 0, internalFormat | 0,
      width | 0, height | 0, border | 0, format >>> 0, type >>> 0, data);
    if (error) owner.errors.add(error);
  }
  texImage3D(target, level, internalFormat, width, height, depth, border, format, type, data) {
    const owner = state(this);
    if (arguments.length !== 10) throw new TypeError('Only the sized typed-array texImage3D overload is implemented');
    if (data !== null && !(data instanceof Uint8Array)) throw new TypeError('Expected Uint8Array or null');
    const error = core.ops.op_gl_tex_image_3d(owner.id, target >>> 0, level | 0, internalFormat | 0,
      width | 0, height | 0, depth | 0, border | 0, format >>> 0, type >>> 0, data);
    if (error) owner.errors.add(error);
  }
  createFramebuffer() { return create(this, 'framebuffer', core.ops.op_gl_create_framebuffer); }
  bindFramebuffer(target, framebuffer) {
    const id = resource(this, framebuffer, 'framebuffer');
    if (id !== undefined) core.ops.op_gl_bind_framebuffer(state(this).id, target >>> 0, id);
  }
  deleteFramebuffer(framebuffer) { remove(this, framebuffer, 'framebuffer', core.ops.op_gl_delete_framebuffer); }
}
installPrograms(ExperimentalWebGLContext.prototype, { state, resource, create, remove, objects });
installGeometry(ExperimentalWebGLContext.prototype, { state, resource, create, remove });

for (const [name, value] of Object.entries(constants)) {
  Object.defineProperty(ExperimentalWebGLContext.prototype, name, { value, enumerable: true });
  Object.defineProperty(ExperimentalWebGLContext, name, { value, enumerable: true });
}
const scalarMethods = {
  stencilMask: ['op_gl_stencil_mask', ['u']],
  clearColor: ['op_gl_clear_color', ['f','f','f','f']], clearDepth: ['op_gl_clear_depth', ['f']],
  clearStencil: ['op_gl_clear_stencil', ['i']], clear: ['op_gl_clear', ['u']],
  blendEquation: ['op_gl_blend_equation', ['u']],
  blendEquationSeparate: ['op_gl_blend_equation_separate', ['u','u']],
  blendFunc: ['op_gl_blend_func', ['u','u']],
  blendFuncSeparate: ['op_gl_blend_func_separate', ['u','u','u','u']],
  blendColor: ['op_gl_blend_color', ['f','f','f','f']],
  enable: ['op_gl_enable', ['u']], disable: ['op_gl_disable', ['u']],
  depthFunc: ['op_gl_depth_func', ['u']], depthMask: ['op_gl_depth_mask', ['b']],
  colorMask: ['op_gl_color_mask', ['b','b','b','b']], frontFace: ['op_gl_front_face', ['u']],
  cullFace: ['op_gl_cull_face', ['u']], viewport: ['op_gl_viewport', ['i','i','i','i']],
  scissor: ['op_gl_scissor', ['i','i','i','i']],
};
for (const [name, [op, types]] of Object.entries(scalarMethods)) {
  Object.defineProperty(ExperimentalWebGLContext.prototype, name, { value: function(...args) {
    const owner = state(this);
    if (args.length < types.length) throw new TypeError(`${name}: missing arguments`);
    core.ops[op](owner.id, ...types.map((type, i) => type === 'b' ? Boolean(args[i]) : type === 'u' ? args[i] >>> 0 : type === 'i' ? args[i] | 0 : Number(args[i])));
  }});
}
// Host-only ownership operations; applications receive just the context facade.
export function contextIdentity(context) {
  return state(context).id;
}

export function closeContext(context) {
  const owner = state(context);
  core.ops.op_angle_dispose(owner.id);
  owner.closed = true;
}
export function observePixel(context, output) { core.ops.op_angle_read_pixel(state(context).id, output); }

export function observeFrame(context, output) {
  const owner = state(context);
  core.ops.op_angle_read_rgba(owner.id, owner.width, owner.height, output);
}

export function resizeContext(context, width, height) {
  const owner = state(context);
  if (![width, height].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 16384)) {
    throw new RangeError('Experimental drawing buffer dimensions must be integers from 1 to 16384');
  }
  core.ops.op_angle_resize(owner.id, width, height);
  owner.width = width;
  owner.height = height;
}
