import { DefaultIntentValidator } from './../defaults/defaultIntentValidator';
import { InMemoryDataAdapter } from './../defaults/inMemoryDataAdapter';
import { SuccessfulResponseValidator } from './../defaults/successfulResponseValidator';
import { assert } from 'chai';
import { faker } from '@faker-js/faker';
import {
    IdempotencyResource,
    IdempotencyRequest,
    IdempotencyResponse,
} from '../models/models';
import * as httpMocks from 'node-mocks-http';
import { IdempotencyService } from './idempotencyService';
import * as express from 'express';
import sinon from 'sinon';

describe('Idempotency service', () => {
    let idempotencyService: IdempotencyService;
    let intentValidator: DefaultIntentValidator;
    let dataAdapter: InMemoryDataAdapter;
    let responseValidator: SuccessfulResponseValidator;

    beforeEach(() => {
        intentValidator = new DefaultIntentValidator();
        dataAdapter = new InMemoryDataAdapter();
        responseValidator = new SuccessfulResponseValidator();

        idempotencyService = new IdempotencyService({
            idempotencyKeyHeader: 'idempotency-key',
            intentValidator,
            dataAdapter,
            responseValidator,
        });
    });

    afterEach(() => {
        sinon.restore();
    });

    it('pass through the request without alteration if no idempotency key', async () => {
        const { req, res } = httpMocks.createMocks();
        const nextSpy = sinon.spy();

        await idempotencyService.provideMiddlewareFunction(req, res, nextSpy);
        assert.isFalse(idempotencyService.isHit(req));
        assert.isTrue(nextSpy.called);
    });

    it('returns same response for same idempotency key', async () => {
        const originalReq = createRequest();

        // First request, which generate a idempotency resource
        const firstReq = createCloneRequest(originalReq);
        const firstRes = httpMocks.createResponse();
        const firstNextSpy = sinon.spy();
        await idempotencyService.provideMiddlewareFunction(
            firstReq,
            firstRes,
            firstNextSpy
        );
        assert.isTrue(firstNextSpy.called);
        // Simulate route. When calling res.json, it will call eventually send.
        firstRes.send('test');

        // Intermediate request, which should generate a conflict
        // because the first one is not completed
        const conflictReq = createCloneRequest(originalReq);
        const conflictRes = httpMocks.createResponse();
        const conflictNextSpy = sinon.spy();
        try {
            await idempotencyService.provideMiddlewareFunction(
                conflictReq,
                conflictRes,
                conflictNextSpy
            );
            assert.fail('Expected conflict error');
        } catch (err) {
            assert.ok(err);
        }

        // Second request
        // Must wait to allow node to handle message which came from the first request
        await wait(1);
        // Now, the idempotency response is available
        const secondReq = createCloneRequest(originalReq);
        const secondRes = httpMocks.createResponse();
        const secondNextSpy = sinon.spy();
        await idempotencyService.provideMiddlewareFunction(
            secondReq,
            secondRes,
            secondNextSpy
        );
        assert.isTrue(secondNextSpy.called);
        assert.isTrue(idempotencyService.isHit(secondReq));
        assert.equal(secondRes._getData(), 'test');
    });

    it('removes resource if error reported', async () => {
        const req = createRequest();

        const nextFunc = sinon.spy();
        await idempotencyService.provideMiddlewareFunction(
            req,
            httpMocks.createResponse(),
            nextFunc
        );
        assert.isTrue(nextFunc.called);
        idempotencyService.reportError(req);
        await wait(1);

        try {
            await idempotencyService.provideMiddlewareFunction(
                req,
                httpMocks.createResponse(),
                sinon.mock()
            );
            assert.isFalse(idempotencyService.isHit(req));
        } catch (err) {
            assert.fail('Expected not to throw any error.');
        }
    });

    it('indicates misuse of the idempotency key', async () => {
        const idempotencyKey = faker.string.uuid();
        const req1 = httpMocks.createRequest({
            url: 'https://something',
            method: 'POST',
            headers: {
                'idempotency-key': idempotencyKey,
            },
        });
        const req2 = httpMocks.createRequest({
            url: 'https://something-else',
            method: 'POST',
            headers: {
                'idempotency-key': idempotencyKey,
            },
        });

        await idempotencyService.provideMiddlewareFunction(
            req1,
            httpMocks.createResponse(),
            sinon.spy()
        );
        await wait(1);
        try {
            await idempotencyService.provideMiddlewareFunction(
                req2,
                httpMocks.createResponse(),
                sinon.spy()
            );
            assert.fail('Expected error thrown for idempotency key misuse');
        } catch (err) {
            assert.ok(err);
        }
    });

    it('ignores response if not valid for persistence', async () => {
        const req = createRequest();
        let res = httpMocks.createResponse();
        const persistanceValidationStud = sinon
            .stub(responseValidator, 'isValidForPersistence')
            .returns(false);

        await idempotencyService.provideMiddlewareFunction(
            req,
            res,
            sinon.mock()
        );
        res.send('something');

        // Be sure that there is no hit from the previous request
        await wait(1);
        res = httpMocks.createResponse();
        await idempotencyService.provideMiddlewareFunction(
            req,
            res,
            sinon.mock()
        );
        assert.isFalse(idempotencyService.isHit(req));
    });

    it('handles correctly error while persisting resource', async () => {
        const req = createRequest();
        const res = httpMocks.createResponse();
        const dataAdapterStub = sinon
            .stub(dataAdapter, 'delete')
            .throws('Doh!');
        const persistanceValidationStud = sinon
            .stub(responseValidator, 'isValidForPersistence')
            .returns(false);

        try {
            await idempotencyService.provideMiddlewareFunction(
                req,
                res,
                sinon.mock()
            );
            res.send('something');
            await wait(1);
            assert.fail('Expected error to be thrown');
        } catch (err) {
            assert.ok(err);
        }

        try {
            await idempotencyService.provideMiddlewareFunction(
                req,
                res,
                sinon.mock()
            );
            await idempotencyService.reportError(req);
            assert.fail('Expected error to be thrown');
        } catch (err) {
            assert.ok(err);
        }
    });

    it('handles response with statusCode undefined (corrupted data)', async () => {
        // This tests our new strict check: availableResponse.statusCode !== undefined
        const idempotencyKey = faker.string.uuid();
        const req = httpMocks.createRequest({
            url: 'https://test',
            method: 'POST',
            headers: {
                'idempotency-key': idempotencyKey,
            },
        });

        // Create corrupted resource with undefined statusCode
        const corruptedResource: IdempotencyResource = {
            idempotencyKey,
            request: {
                url: req.url,
                method: req.method,
                headers: req.headers,
                body: req.body,
                query: req.query,
            },
            response: {
                statusCode: undefined, // Corrupted!
                headers: {},
                body: 'test',
            },
        };

        // Stub data adapter to return corrupted resource
        sinon
            .stub(dataAdapter, 'findByIdempotencyKey')
            .resolves(corruptedResource);

        const res = httpMocks.createResponse();
        const nextSpy = sinon.stub().callsFake((err?: Error) => {
            if (err) {
                throw err;
            }
        });

        // Should treat as "request in progress" (no valid response)
        try {
            await idempotencyService.provideMiddlewareFunction(
                req,
                res,
                nextSpy
            );
            assert.fail('Expected conflict error for corrupted response');
        } catch (err) {
            assert.ok(err);
            assert.include(
                (err as Error).message,
                'A previous request is still in progress'
            );
        }
    });

    it('handles reportError without idempotency key', async () => {
        // This tests our new check: if (idempotencyKey) before delete
        const req = httpMocks.createRequest({
            url: 'https://test',
            method: 'POST',
            // No idempotency-key header
        });

        const deleteSpy = sinon.spy(dataAdapter, 'delete');

        // Should not throw and should not call delete
        await idempotencyService.reportError(req);

        assert.isFalse(deleteSpy.called);
    });

    it('verifies sendHook returns response for method chaining', async () => {
        // This tests our bug fix: return defaultSend(body)
        const req = createRequest();
        const res = httpMocks.createResponse();
        const nextSpy = sinon.spy();

        await idempotencyService.provideMiddlewareFunction(req, res, nextSpy);

        // Call send and verify it returns the response object
        const result = res.send('test data');

        // In Express, send() should return the response for chaining
        assert.equal(result, res);
    });

    it('restores content-type header from cached response', async () => {
        // This tests line 110: res.setHeader(header, availableResponse.headers[header])
        const originalReq = createRequest();

        // First request with content-type
        const firstReq = createCloneRequest(originalReq);
        const firstRes = httpMocks.createResponse();
        firstRes.setHeader('content-type', 'application/json');

        await idempotencyService.provideMiddlewareFunction(
            firstReq,
            firstRes,
            sinon.spy()
        );
        firstRes.send({ data: 'test' });

        // Wait for async processing
        await wait(1);

        // Second request should get the cached response with content-type
        const secondReq = createCloneRequest(originalReq);
        const secondRes = httpMocks.createResponse();

        await idempotencyService.provideMiddlewareFunction(
            secondReq,
            secondRes,
            sinon.spy()
        );

        // Verify content-type header was restored
        assert.equal(secondRes.getHeader('content-type'), 'application/json');
    });

    it('handles data adapter findByIdempotencyKey error', async () => {
        // This tests error handling for findByIdempotencyKey
        const req = createRequest();
        const res = httpMocks.createResponse();

        sinon
            .stub(dataAdapter, 'findByIdempotencyKey')
            .rejects(new Error('Database error'));

        const nextSpy = sinon.spy();

        // Should propagate the error
        try {
            await idempotencyService.provideMiddlewareFunction(
                req,
                res,
                nextSpy
            );
            assert.fail('Expected error to be thrown');
        } catch (err) {
            assert.ok(err);
            assert.include((err as Error).message, 'Database error');
        }
    });
});

function createRequest(): express.Request {
    return httpMocks.createRequest({
        url: faker.internet.url(),
        method: faker.helpers.arrayElement(['GET', 'POST', 'PUT', 'DELETE']),
        headers: {
            'idempotency-key': faker.string.uuid(),
        },
    });
}

function createCloneRequest(req: express.Request): express.Request {
    return httpMocks.createRequest({
        url: req.url,
        method: req.method as httpMocks.RequestMethod,
        headers: req.headers,
    });
}

async function wait(ms: number) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
