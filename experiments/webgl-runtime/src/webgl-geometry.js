import { core } from 'ext:core/mod.js';

export function installGeometry(prototype, { state, resource, create, remove }) {
  const ops = core.ops;
  function result(receiver, error) { if (error) state(receiver).errors.add(error); }
  function view(receiver, data, offset = 0, length = 0) {
    const owner = state(receiver);
    let buffer, byteOffset, byteLength, elementSize;
    if (data instanceof ArrayBuffer) {
      buffer = data; byteOffset = 0; byteLength = data.byteLength; elementSize = 1;
    } else if (ArrayBuffer.isView(data) && data.buffer instanceof ArrayBuffer) {
      buffer = data.buffer; byteOffset = data.byteOffset; byteLength = data.byteLength;
      elementSize = data.BYTES_PER_ELEMENT ?? 1;
    } else {
      throw new TypeError('Expected an ArrayBuffer or non-shared view');
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || offset > byteLength / elementSize) {
      owner.errors.add(0x501); return undefined;
    }
    const count = length === 0 ? byteLength / elementSize - offset : length;
    if (count > byteLength / elementSize - offset) { owner.errors.add(0x501); return undefined; }
    return new Uint8Array(buffer, byteOffset + offset * elementSize, count * elementSize);
  }
  Object.assign(prototype, {
    createBuffer() { return create(this, 'buffer', ops.op_wgl_create_buffer); },
    bindBuffer(target, buffer) {
      const id = resource(this, buffer, 'buffer');
      if (id !== undefined) result(this, ops.op_wgl_bind_buffer(state(this).id, target >>> 0, id));
    },
    deleteBuffer(buffer) { remove(this, buffer, 'buffer', ops.op_wgl_delete_buffer); },
    bufferData(target, data, usage, srcOffset = 0, length = 0) {
      const owner = state(this);
      if (typeof data === 'number') {
        result(this, ops.op_wgl_buffer_data_size(owner.id, target >>> 0, data, usage >>> 0));
      } else if (data === null) {
        owner.errors.add(0x501);
      } else {
        const bytes = view(this, data, srcOffset, length);
        if (bytes !== undefined) result(this, ops.op_wgl_buffer_data_bytes(owner.id, target >>> 0, bytes, usage >>> 0));
      }
    },
    bufferSubData(target, offset, data, srcOffset = 0, length = 0) {
      const bytes = view(this, data, srcOffset, length);
      if (bytes !== undefined) result(this, ops.op_wgl_buffer_sub_data(state(this).id, target >>> 0, Number(offset), bytes));
    },
    createVertexArray() { return create(this, 'vertex-array', ops.op_wgl_create_vertex_array); },
    bindVertexArray(array) {
      const id = resource(this, array, 'vertex-array');
      if (id !== undefined) ops.op_wgl_bind_vertex_array(state(this).id, id);
    },
    deleteVertexArray(array) { remove(this, array, 'vertex-array', ops.op_wgl_delete_vertex_array); },
    enableVertexAttribArray(index) { ops.op_wgl_enable_vertex_attrib_array(state(this).id, index >>> 0); },
    disableVertexAttribArray(index) { ops.op_wgl_disable_vertex_attrib_array(state(this).id, index >>> 0); },
    vertexAttribDivisor(index, divisor) { ops.op_wgl_vertex_attrib_divisor(state(this).id, index >>> 0, divisor >>> 0); },
    vertexAttribPointer(index, size, type, normalized, stride, offset) {
      result(this, ops.op_wgl_vertex_attrib_pointer(state(this).id, index >>> 0, size | 0, type >>> 0,
        Boolean(normalized), stride | 0, Number(offset)));
    },
    drawArrays(mode, first, count) {
      result(this, ops.op_wgl_draw_arrays(state(this).id, mode >>> 0, first | 0, count | 0));
    },
    drawElements(mode, count, type, offset) {
      result(this, ops.op_wgl_draw_elements(state(this).id, mode >>> 0, count | 0, type >>> 0, Number(offset)));
    },
  });
}
