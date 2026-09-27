import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import type {
  DocumentRead,
  DocumentSummary,
  SaveInput,
} from "@grasp-os/shared/knowledge";

import type { Session } from "../core.ts";

/** A save that went through, or the newer version it would have overwritten. */
export type SaveOutcome = { saved: DocumentSummary } | { newer: DocumentRead };

/**
 * Saves `input` as the document's next version. When someone saved one
 * after the version it was edited from, core saves nothing
 * (`knowledge.conflict`), and this reads the version that is current now,
 * to show instead. Outside components, as the React Compiler can't
 * compile `try`/`catch` around a value it returns.
 */
export const saveOrNewer = async (
  session: Session,
  documentId: string,
  input: SaveInput
): Promise<SaveOutcome> => {
  try {
    return { saved: await session.knowledge.saveDocument(input) };
  } catch (error) {
    if (knowledgeErrors.codeOf(error) !== "knowledge.conflict") {
      throw error;
    }
  }
  return { newer: await session.knowledge.getDocument(documentId) };
};
