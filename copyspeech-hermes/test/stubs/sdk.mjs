// Stand-in for @hermes/plugin-sdk in Node. The tests set globalThis.host per test,
// so host forwards every read to that object at call time.
export const PALETTE_AREA = "palette";
export const host = new Proxy(
  {},
  {
    get: (_target, key) => globalThis.host[key]
  }
);
export const atom = (initial) => {
  let value = initial;
  return {
    get: () => value,
    set: (next) => {
      value = next;
    }
  };
};
export const Button = () => null;
export const Input = () => null;
export const SegmentedControl = () => null;
export const ToggleRow = () => null;
export const useQuery = () => ({ data: undefined });
export const useValue = (atomValue) => atomValue.get();
