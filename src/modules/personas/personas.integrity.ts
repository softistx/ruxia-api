// What the personas module needs of the others, as ports the registry passes
// (never defaulted). `ModelsService` implements `PersonaModels`.
export interface PersonaModels {
  // Whether the catalogue holds the model and an administrator enabled it.
  // Availability is not asked: an Ollama model that is offline is accepted.
  enabled(id: string): Promise<boolean>;
}

// Who uploaded an avatar file, and who may use it: `AvatarsService`
// implements it.
export interface AvatarClaims {
  // Whether `viewerId` uploaded `key` (so may link it to a persona).
  uploadedBy(viewerId: string, key: string): Promise<boolean>;
}

// What a persona shows of its owner: the member's id and name, nothing else.
export interface PersonaOwner {
  id: string;
  name: string;
}

// Which of the ids are the member's own live projects: what a persona may be
// bound to. `ProjectsService` implements it.
export interface PersonaProjects {
  owned(ids: readonly string[]): Promise<ReadonlySet<string>>;
}
