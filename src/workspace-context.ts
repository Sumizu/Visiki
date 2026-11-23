import { createContext, useContext } from 'react';

// Each workspace owns its editor state; the shell supplies only view activity and chrome size.
export const WorkspaceContext = createContext({ active: true, topInset: 0 });
export const useWorkspace = () => useContext(WorkspaceContext);
