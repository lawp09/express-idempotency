// Copyright (c) Ville de Montreal. All rights reserved.
// Licensed under the MIT license.
// See LICENSE file in the project root for full license information.

import { IdempotencyResource, IIdempotencyDataAdapter } from '../models/models';

/**
 * In memory data adapter using a Map for O(1) operations.
 * Not recommended for production - use Redis or MongoDB adapter instead.
 *
 * Limitations:
 * - No TTL: resources never expire (memory leak over time)
 * - No size limit: vulnerable to memory exhaustion
 * - Suitable for development and testing only
 */
export class InMemoryDataAdapter implements IIdempotencyDataAdapter {
    // Resource storage using Map for O(1) lookups
    private idempotencyResources: Map<string, IdempotencyResource> = new Map();

    public async findByIdempotencyKey(
        idempotencyKey: string
    ): Promise<IdempotencyResource | null> {
        return this.idempotencyResources.get(idempotencyKey) ?? null;
    }

    public async create(
        idempotencyResource: IdempotencyResource
    ): Promise<void> {
        if (this.idempotencyResources.has(idempotencyResource.idempotencyKey)) {
            throw new Error('Duplicate');
        }
        this.idempotencyResources.set(
            idempotencyResource.idempotencyKey,
            idempotencyResource
        );
    }

    public async update(
        idempotencyResource: IdempotencyResource
    ): Promise<void> {
        this.idempotencyResources.set(
            idempotencyResource.idempotencyKey,
            idempotencyResource
        );
    }

    public async delete(idempotencyKey: string): Promise<void> {
        this.idempotencyResources.delete(idempotencyKey);
    }
}
