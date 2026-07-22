// This subpath's package export maps straight to a .css file with no `types` entry, and the
// specifier doesn't literally end in ".css", so vite/client's ambient `declare module '*.css'`
// wildcard doesn't match it either - without this, tsc fails with "Cannot find module".
declare module '@diplodoc/latex-extension/runtime/styles' {}
