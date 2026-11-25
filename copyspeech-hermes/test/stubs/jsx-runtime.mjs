// Stand-in for react/jsx-runtime in Node. Elements are plain objects; no test renders them.
export const jsx = (type, props) => ({ type, props });
export const jsxs = (type, props) => ({ type, props });
