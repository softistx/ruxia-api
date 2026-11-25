import { defineMongo, openMongo } from "@softistx/mongo";
import { type Collection, type Db, type Document, ObjectId } from "mongodb";
import { appMongo } from "../src/config/db";
import * as collections from "../src/modules/collections";

// For the migration specs: creates the app's collections in `db` with their
// synced `$jsonSchema` validators (strict), as `bun run db:sync` leaves a real
// database, so a legacy-shaped document a migration forgets to backfill is
// refused (error 121) instead of silently accepted.
export async function syncValidators(db: Db) {
  const mongo = await openMongo(
    defineMongo({
      client: appMongo.db.client,
      database: db.databaseName,
      collections,
      autoSync: false,
    }),
  );
  await mongo.sync();
  await mongo.close();
}

// Writes documents the way an older version stored them: the validator is
// bypassed on the insert only (the legacy shape is invalid now, which is what
// the migration under test repairs).
export const insertLegacy = (
  collection: Collection<Document>,
  ...documents: Document[]
) => collection.insertMany(documents, { bypassDocumentValidation: true });

// Rewrites every document of `collection` as it is, validator on: it throws
// (error 121) when one no longer satisfies the synced validator.
export async function expectValid(collection: Collection<Document>) {
  for (const document of await collection.find({}).toArray()) {
    await collection.replaceOne({ _id: document["_id"] }, document);
  }
}

const now = new Date("2026-10-30T10:00:00Z");
const actor = "0190a000-0000-7000-8000-000000000002";

// A question as stored before the content model (no hints, references, origin,
// review state, code, nor choice explanation), complete otherwise.
export const legacyQuestion = (over: Document = {}): Document => ({
  _id: new ObjectId(),
  topicId: new ObjectId(),
  type: "open",
  difficulty: "medium",
  prompt: "Prompt",
  choices: null,
  referenceAnswer: "Answer",
  explanation: null,
  points: 1,
  tags: [],
  media: null,
  searchWords: ["prompt"],
  claims: 0,
  version: 1,
  createdAt: now,
  updatedAt: now,
  createdBy: actor,
  updatedBy: actor,
  archivedAt: null,
  archivedBy: null,
  ...over,
});

// A snapshot question as stored before the content model.
export const legacySnapshot = (over: Document = {}): Document => ({
  id: new ObjectId(),
  type: "open",
  difficulty: "medium",
  prompt: "Prompt",
  choices: null,
  referenceAnswer: "Answer",
  explanation: null,
  points: 1,
  media: null,
  ...over,
});

// An attempt as stored before the content model.
export const legacyAttempt = (questions: Document[]): Document => ({
  _id: new ObjectId(),
  learnerId: "0190a000-0000-7000-8000-000000000001",
  quizId: new ObjectId(),
  subjectId: new ObjectId(),
  status: "in_progress",
  questions,
  answers: [],
  pointsEarned: 0,
  pointsPossible: questions.length,
  scorePercentage: null,
  passed: null,
  passingScorePercentage: null,
  startedAt: now,
  deadline: null,
  completedAt: null,
  version: 1,
  createdAt: now,
  updatedAt: now,
});

// A `down` removes fields the validator requires, so it can only run where the
// validator is off (the previous code's own `db:sync` replaces it): for the
// specs of a `down`.
export async function relaxValidators(db: Db) {
  for (const name of ["questions", "quiz_attempts"]) {
    await db.command({ collMod: name, validationLevel: "off" });
  }
}
