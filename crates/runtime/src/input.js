// This adapts the native window fixture. DOM targeting and UIEvent subclasses
// belong to the DOM binding; the fixture exposes Event plus readonly fields.
export function createInputDispatcher({ keyboardTarget, pointerTarget, dispatch,
  markTrusted, validateTarget, checkpoint }) {
  const nativeEvents = new WeakSet();
  const eventPhase = Object.getOwnPropertyDescriptor(Event.prototype, "eventPhase").get;
  const isTrusted = Object.getOwnPropertyDescriptor(Event.prototype, "isTrusted").get;
  const defaultPrevented = Object.getOwnPropertyDescriptor(Event.prototype, "defaultPrevented").get;
  const original = EventTarget.prototype.dispatchEvent;
  Object.defineProperty(EventTarget.prototype, "dispatchEvent", {
    ...Object.getOwnPropertyDescriptor(EventTarget.prototype, "dispatchEvent"),
    value: function dispatchEvent(event) {
      if (nativeEvents.has(event)) {
        validateTarget(this ?? keyboardTarget);
        // Deno's empty-listener shortcut precedes its reentrant-dispatch check.
        if (Reflect.apply(eventPhase, event, []) !== Event.NONE) {
          throw new DOMException("Invalid event state", "InvalidStateError");
        }
        markTrusted(event, false);
      }
      const result = Reflect.apply(original, this, arguments);
      return nativeEvents.has(event) ? !Reflect.apply(defaultPrevented, event, []) : result;
    },
  });

  function emit(target, type, fields = {}, cancelable = false) {
    const event = new Event(type, { cancelable });
    for (const [key, value] of Object.entries(fields)) {
      Object.defineProperty(event, key, { value, enumerable: true });
    }
    Object.defineProperty(event, "isTrusted", {
      enumerable: true,
      get() { return Reflect.apply(isTrusted, this, []); },
    });
    nativeEvents.add(event);
    markTrusted(event, true);
    dispatch(target, event);
    checkpoint();
  }

  const position = ({ x, y }) => ({ clientX: x, clientY: y, pageX: x, pageY: y,
    offsetX: x, offsetY: y, x, y });
  return input => {
    switch (input.kind) {
      case "key":
        emit(keyboardTarget, input.pressed ? "keydown" : "keyup", {
          key: input.key, code: input.code, location: input.location,
          repeat: input.repeat, isComposing: false, ...input.modifiers,
        }, true);
        break;
      case "mouse":
        emit(pointerTarget, `mouse${input.event}`, {
          ...position(input.position), button: input.button, buttons: input.buttons,
          ...input.modifiers,
        }, input.event !== "leave");
        break;
      case "wheel":
        emit(pointerTarget, "wheel", {
          ...position(input.position), button: 0, buttons: input.buttons,
          deltaX: input.delta_x, deltaY: input.delta_y, deltaZ: 0,
          deltaMode: input.delta_mode, ...input.modifiers,
        }, true);
        break;
      case "focus":
        emit(keyboardTarget, input.focused ? "focus" : "blur");
        break;
      default:
        throw new TypeError(`Unknown native input kind: ${input.kind}`);
    }
  };
}
