import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

let mongod: MongoMemoryServer | undefined;

/** One in-memory mongod for the whole run; every test file uses its own database on it. */
export async function setup(project: TestProject) {
  mongod = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION || '7.0.24' } });
  project.provide('mongoUri', mongod.getUri());
}

export async function teardown() {
  await mongod?.stop();
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
