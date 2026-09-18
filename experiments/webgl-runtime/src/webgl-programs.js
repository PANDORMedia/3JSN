import { core } from 'ext:core/mod.js';

export function installPrograms(prototype, { state, resource, create, remove, objects }) {
  const ops = core.ops;
  function call(receiver, object, kind, op, ...args) {
    const owner = state(receiver);
    const id = resource(receiver, object, kind);
    if (id === undefined) return undefined;
    if (id === 0) { owner.errors.add(0x501); return undefined; }
    return op(owner.id, id, ...args);
  }
  function uniform(receiver, location) {
    const owner = state(receiver);
    if (location === null) return undefined;
    const id = resource(receiver, location, 'uniform-location');
    if (id === undefined) return undefined;
    const value = objects.get(location);
    const program = objects.get(value.program);
    if (program.generation !== value.generation) {
      owner.errors.add(0x502); return undefined;
    }
    return id;
  }
  function result(receiver, error) { if (error) state(receiver).errors.add(error); }
  function values(receiver, data, Type, offset = 0, length = 0) {
    const maximum = 1024 * 1024;
    let array;
    if (data instanceof Type) {
      if (!(data.buffer instanceof ArrayBuffer)) throw new TypeError('Shared uniform arrays are not implemented');
      array = data;
    } else {
      if (data === null || (typeof data !== 'object' && typeof data !== 'function') || typeof data[Symbol.iterator] !== 'function') {
        throw new TypeError('Expected a typed array or numeric sequence');
      }
      const items = [];
      for (const value of data) {
        if (items.length === maximum) { state(receiver).errors.add(0x501); return undefined; }
        items.push(Number(value));
      }
      array = new Type(items);
    }
    if (array.length > maximum) { state(receiver).errors.add(0x501); return undefined; }
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || offset > array.length) {
      state(receiver).errors.add(0x501); return undefined;
    }
    const count = length === 0 ? array.length - offset : length;
    if (count > array.length - offset) { state(receiver).errors.add(0x501); return undefined; }
    return offset === 0 && count === array.length ? array : array.subarray(offset, offset + count);
  }
  Object.assign(prototype, {
    createShader(type) {
      const owner = state(this); type >>>= 0;
      if (type !== 0x8b31 && type !== 0x8b30) { owner.errors.add(0x500); return null; }
      return create(this, 'shader', context => ops.op_gl_create_shader(context, type));
    },
    shaderSource(shader, source) {
      const id = resource(this, shader, 'shader');
      if (id === undefined) return;
      if (id === 0) { state(this).errors.add(0x501); return; }
      source = String(source);
      ops.op_wgl_shader_source(state(this).id, id, source);
      objects.get(shader).source = source;
    },
    getShaderSource(shader) {
      const id = resource(this, shader, 'shader');
      if (!id) return null;
      return objects.get(shader).source ?? '';
    },
    compileShader(shader) { call(this, shader, 'shader', ops.op_wgl_compile_shader); },
    getShaderParameter(shader, pname) { return call(this, shader, 'shader', ops.op_wgl_shader_parameter, pname >>> 0)?.value ?? null; },
    getShaderInfoLog(shader) { return call(this, shader, 'shader', ops.op_wgl_shader_info_log) ?? null; },
    deleteShader(shader) { remove(this, shader, 'shader', ops.op_gl_delete_shader); },
    createProgram() {
      const program = create(this, 'program', ops.op_gl_create_program);
      objects.get(program).generation = 0;
      return program;
    },
    attachShader(program, shader) {
      const p = resource(this, program, 'program'), s = resource(this, shader, 'shader');
      if (p === undefined || s === undefined) return;
      if (p === 0 || s === 0) { state(this).errors.add(0x501); return; }
      ops.op_gl_attach_shader(state(this).id, p, s);
    },
    bindAttribLocation(program, index, name) { call(this, program, 'program', ops.op_wgl_bind_attrib_location, index >>> 0, String(name)); },
    linkProgram(program) {
      const id = resource(this, program, 'program');
      if (id === undefined) return;
      if (id === 0) { state(this).errors.add(0x501); return; }
      objects.get(program).generation++;
      ops.op_wgl_link_program(state(this).id, id);
    },
    getProgramParameter(program, pname) { return call(this, program, 'program', ops.op_wgl_program_parameter, pname >>> 0)?.value ?? null; },
    getProgramInfoLog(program) { return call(this, program, 'program', ops.op_wgl_program_info_log) ?? null; },
    getActiveUniform(program, index) { return call(this, program, 'program', ops.op_wgl_get_active_uniform, index >>> 0) ?? null; },
    getActiveAttrib(program, index) { return call(this, program, 'program', ops.op_wgl_get_active_attrib, index >>> 0) ?? null; },
    getAttribLocation(program, name) { return call(this, program, 'program', ops.op_wgl_get_attrib_location, String(name)) ?? -1; },
    getUniformLocation(program, name) {
      const id = call(this, program, 'program', ops.op_wgl_get_uniform_location, String(name));
      if (!id) return null;
      const location = Object.freeze(Object.create(null));
      objects.set(location, { owner: state(this), kind: 'uniform-location', id, deleted: false,
        program, generation: objects.get(program).generation });
      return location;
    },
    useProgram(program) {
      const id = resource(this, program, 'program');
      if (id !== undefined) ops.op_wgl_use_program(state(this).id, id);
    },
    deleteProgram(program) { remove(this, program, 'program', ops.op_gl_delete_program); },
  });
  for (const components of [1, 2, 3, 4]) {
    for (const [suffix, op, Type] of [['f', ops.op_wgl_uniform_float, Float32Array], ['i', ops.op_wgl_uniform_int, Int32Array]]) {
      prototype[`uniform${components}${suffix}`] = function(location, x = 0, y = 0, z = 0, w = 0) {
        const id = uniform(this, location);
        if (id !== undefined) result(this, op(state(this).id, id, components,
          suffix === 'i' ? x | 0 : Number(x), suffix === 'i' ? y | 0 : Number(y),
          suffix === 'i' ? z | 0 : Number(z), suffix === 'i' ? w | 0 : Number(w)));
      };
      prototype[`uniform${components}${suffix}v`] = function(location, data, offset = 0, length = 0) {
        const id = uniform(this, location);
        if (id === undefined) return;
        const value = values(this, data, Type, offset, length);
        if (value !== undefined) result(this, (suffix === 'f' ? ops.op_wgl_uniform_fv : ops.op_wgl_uniform_iv)(state(this).id, id, components, suffix === 'i' ? new Uint32Array(value.buffer, value.byteOffset, value.length) : value));
      };
    }
  }
  for (const dimension of [2, 3, 4]) {
    prototype[`uniformMatrix${dimension}fv`] = function(location, transpose, data, offset = 0, length = 0) {
      const id = uniform(this, location);
      if (id === undefined) return;
      const value = values(this, data, Float32Array, offset, length);
      if (value !== undefined) result(this, ops.op_wgl_uniform_matrix(state(this).id, id, dimension, Boolean(transpose), value));
    };
  }
}
