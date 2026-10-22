# Contributing to DockSlot

Thanks for helping build transparent, self-hosted dock operations software.

1. Read the README, architecture and current implementation status.
2. Discuss significant domain changes in an issue with an operational example.
3. Use Node 24, `npm ci`, a fresh PostgreSQL test database and a feature branch.
4. Preserve tenant isolation, the allocation exclusion constraint, append-only audit history, explicit human recovery approval and unknown-data handling.
5. Add tests for behavior that can violate scheduling, authorization, concurrency or data integrity. Interface copy/style changes do not need implementation-mirroring tests.
6. Run type checking, relevant tests and the web build. Include screenshots for visible changes and migration/rollback notes for storage changes.

Domain and engine packages must remain independent of Fastify, React and database access. All site mutations acquire the site row lock and produce audit/outbox events in the same transaction. Avoid introducing mandatory external services.

Use plain English for code, issues and documentation. Translation contributions are welcome. Contributions are licensed under Apache-2.0; by submitting a contribution you confirm you have the right to license it accordingly. No CLA is required.

Be respectful, specific and constructive. Critique implementations and ideas, not people. Maintainers may remove harassment, personal data, spam or unsafe disclosures.
