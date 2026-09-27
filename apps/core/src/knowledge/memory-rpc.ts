import type { DocumentSummary } from "@grasp-os/shared/knowledge";
import type {
  MemoryApi,
  MemoryCollections,
  MemoryWarning,
  ProposalPage,
  ProposalsOptions,
} from "@grasp-os/shared/memory";
import { RpcTarget } from "capnweb";

import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import {
  approveProposal,
  listProposals,
  memoryWarnings,
  declineProposal,
} from "./memory-proposals.ts";
import { memoryCollections } from "./memory.ts";

/** Memory for a signed-in person over `/rpc`, as `KnowledgeRpc` is. */
export class MemoryRpc extends RpcTarget implements MemoryApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async collections(): Promise<MemoryCollections> {
    return await withPerson(
      this.#check,
      async (person) => await memoryCollections(this.#env, person)
    );
  }

  async proposals(options?: ProposalsOptions): Promise<ProposalPage> {
    return await withPerson(
      this.#check,
      async (person) => await listProposals(this.#env, person, options)
    );
  }

  async approve(proposalId: string): Promise<DocumentSummary> {
    return await withPerson(
      this.#check,
      async (person) => await approveProposal(this.#env, person, proposalId)
    );
  }

  async decline(proposalId: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await declineProposal(this.#env, person, proposalId);
    });
  }

  async warnings(text: string): Promise<MemoryWarning[]> {
    return await withPerson(
      this.#check,
      async (person) => await memoryWarnings(this.#env, person, text)
    );
  }
}
