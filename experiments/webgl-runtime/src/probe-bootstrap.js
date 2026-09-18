import './webgl-bootstrap.js';
import { core } from 'ext:core/mod.js';

// This test-only entry point is separate from the eventual canvas WebGL API.
globalThis.__angleProbe = Object.freeze({
  getError: core.ops.op_gl_get_error,
  getParameter: core.ops.op_gl_get_parameter,
  createShader: core.ops.op_gl_create_shader,
  compileShader: core.ops.op_gl_compile_shader,
  shaderStatus: core.ops.op_gl_shader_status,
  createProgram: core.ops.op_gl_create_program,
  attachShader: core.ops.op_gl_attach_shader,
  linkProgram: core.ops.op_gl_link_program,
  deleteShader: core.ops.op_gl_delete_shader,
  deleteProgram: core.ops.op_gl_delete_program,
  create: core.ops.op_angle_create,
  info: core.ops.op_angle_info,
  clear: core.ops.op_angle_clear,
  pixel: core.ops.op_angle_read_pixel,
  resize: core.ops.op_angle_resize,
  dispose: core.ops.op_angle_dispose,
});
