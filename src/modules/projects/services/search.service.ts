import type { AnyTool } from "@softistx/ai-core";
import { ObjectId } from "mongodb";
import type { Viewer } from "../../../auth/viewer";
import type { AppMongo } from "../../../config/db";
import type { ProjectEmbedder } from "../projects.integrity";
import {
  MAX_BOUND_PROJECTS,
  projectBlock,
  TOP_CHUNKS,
} from "../projects.rules";
import { searchProjectTool } from "../projects.tools";
import { asQuery, type Passage, roundedScore } from "../projects.utils";
import type { VectorHit, VectorIndex } from "../projects.vector";
import type { ProjectsService } from "./projects.service";

// What a run takes of the projects: the instructions for the system prompt and
// the `search_project` tool, both empty when no project applies.
export interface ProjectKit {
  instructions: string | null;
  tools: AnyTool[];
}

// The search of the member's own projects, for one request (the guard ran
// first): the vectors are searched for the viewer's id and one project at a
// time, so nothing of another member's can match.
export class ProjectSearchService {
  constructor(
    private readonly deps: {
      mongo: Pick<AppMongo, "db">;
      embedder: ProjectEmbedder;
      vectors: Pick<VectorIndex, "search">;
    },
    private readonly projects: Pick<ProjectsService, "live">,
    private readonly viewer: Viewer | null,
  ) {}

  private get actor() {
    if (!this.viewer) throw new Error("projects: a search needs a viewer");
    return this.viewer.id;
  }

  // The best passages of the given projects (at most 6 in all), best first,
  // each whole, with the name of its document (a document that is not INDEXED
  // is left out). A project that is not the member's
  // live one is skipped.
  async search(
    projectIds: readonly string[],
    query: string,
    signal: AbortSignal,
  ): Promise<Passage[]> {
    const projects = await this.projects.live(projectIds);
    if (projects.length === 0) return [];
    const [vector] = await this.deps.embedder.embed([asQuery(query)], signal);
    if (vector === undefined) return [];
    const found = await Promise.all(
      projects.map((project) =>
        this.deps.vectors.search({
          ownerId: this.actor,
          projectId: String(project._id),
          vector,
          limit: TOP_CHUNKS,
        }),
      ),
    );
    const best = found
      .flat()
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_CHUNKS);
    return this.cited(best);
  }

  private async cited(hits: readonly VectorHit[]): Promise<Passage[]> {
    const ids = [...new Set(hits.map((hit) => hit.documentId))];
    const documents = await this.deps.mongo.db.projectDocuments.raw
      .find({
        _id: { $in: ids.map((id) => new ObjectId(id)) },
        ownerId: this.actor,
        status: "indexed",
      })
      .toArray();
    const names = new Map(documents.map((d) => [String(d._id), d.name]));
    return hits.flatMap((hit) => {
      const name = names.get(hit.documentId);
      if (name === undefined) return [];
      return [
        {
          documentId: hit.documentId,
          name,
          text: hit.text,
          score: roundedScore(hit.score),
        },
      ];
    });
  }

  // The projects a run works in: the conversation's own, else the ones its
  // persona is bound to (the first five, the member's own live ones). The
  // instructions and the tool join the run when there is any.
  async kit(
    conversation: { projectId: string | null },
    persona: { projectIds: readonly string[] },
  ): Promise<ProjectKit> {
    const wanted =
      conversation.projectId === null
        ? persona.projectIds.slice(0, MAX_BOUND_PROJECTS)
        : [conversation.projectId];
    const projects = await this.projects.live(wanted);
    if (projects.length === 0) return { instructions: null, tools: [] };
    const ids = projects.map((project) => String(project._id));
    return {
      instructions: projectBlock(projects),
      tools: [
        searchProjectTool((query, signal) => this.search(ids, query, signal)),
      ],
    };
  }
}
