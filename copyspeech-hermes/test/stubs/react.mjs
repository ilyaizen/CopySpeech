// Stand-in for react in Node. The tests never render, so hooks only need to exist.
export const useEffect = () => {};
export const useState = (initial) => [initial, () => {}];
