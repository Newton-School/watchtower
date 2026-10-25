import { configure } from '@testing-library/react';

// The thread view's tests walk a run through several polls and re-renders, each
// a short wait for the next text. Testing Library gives each wait 1 s by
// default; with the sidecar suite running alongside (or another build), a
// re-render alone can take longer, and the tests failed for that reason only.
configure({ asyncUtilTimeout: 5000 });
