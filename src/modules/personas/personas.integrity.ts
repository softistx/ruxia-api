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
