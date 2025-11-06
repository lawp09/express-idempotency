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

    describe('Request header security', () => {
        it('filters authorization header from stored request', async () => {
            const req = httpMocks.createRequest({
                url: 'https://test',
                method: 'POST',
                headers: {
                    'idempotency-key': faker.string.uuid(),
                    authorization: 'Bearer secret-token',
                    'content-type': 'application/json',
                },
            });

            const nextSpy = sinon.spy();
            await idempotencyService.provideMiddlewareFunction(
                req,
                httpMocks.createResponse(),
                nextSpy
            );

            // Verify resource was created without authorization header
            const idempotencyKey =
                idempotencyService.extractIdempotencyKeyFromReq(req);
            const resource = await dataAdapter.findByIdempotencyKey(
                idempotencyKey!
            );
            assert.ok(resource);
            assert.isUndefined(resource.request.headers.authorization);
            assert.equal(
                resource.request.headers['content-type'],
                'application/json'
            );
        });

        it('filters cookie header from stored request', async () => {
            const req = httpMocks.createRequest({
                url: 'https://test',
                method: 'POST',
                headers: {
                    'idempotency-key': faker.string.uuid(),
                    cookie: 'session=abc123',
                    'content-type': 'application/json',
                },
            });

            const nextSpy = sinon.spy();
            await idempotencyService.provideMiddlewareFunction(
                req,
                httpMocks.createResponse(),
                nextSpy
            );

            const idempotencyKey =
                idempotencyService.extractIdempotencyKeyFromReq(req);
            const resource = await dataAdapter.findByIdempotencyKey(
                idempotencyKey!
            );
            assert.ok(resource);
            assert.isUndefined(resource.request.headers.cookie);
            assert.equal(
                resource.request.headers['content-type'],
                'application/json'
            );
        });

        it('filters x-api-key header from stored request', async () => {
            const req = httpMocks.createRequest({
                url: 'https://test',
                method: 'POST',
                headers: {
                    'idempotency-key': faker.string.uuid(),
                    'x-api-key': 'secret-api-key',
                    'content-type': 'application/json',
                },
            });

            const nextSpy = sinon.spy();
            await idempotencyService.provideMiddlewareFunction(
                req,
                httpMocks.createResponse(),
                nextSpy
            );

            const idempotencyKey =
                idempotencyService.extractIdempotencyKeyFromReq(req);
            const resource = await dataAdapter.findByIdempotencyKey(
                idempotencyKey!
            );
            assert.ok(resource);
            assert.isUndefined(resource.request.headers['x-api-key']);
            assert.equal(
                resource.request.headers['content-type'],
                'application/json'
            );
        });

        it('filters all sensitive headers: authorization, proxy-authorization, cookie, set-cookie, x-auth-token, x-csrf-token, x-xsrf-token', async () => {
            const req = httpMocks.createRequest({
                url: 'https://test',
                method: 'POST',
                headers: {
                    'idempotency-key': faker.string.uuid(),
                    authorization: 'Bearer token',
                    'proxy-authorization': 'Basic token',
                    cookie: 'session=123',
                    'set-cookie': ['id=abc'],
                    'x-auth-token': 'auth123',
                    'x-csrf-token': 'csrf123',
                    'x-xsrf-token': 'xsrf123',
                    'content-type': 'application/json',
                    accept: 'application/json',
                },
            });

            const nextSpy = sinon.spy();
            await idempotencyService.provideMiddlewareFunction(
                req,
                httpMocks.createResponse(),
                nextSpy
            );

            const idempotencyKey =
                idempotencyService.extractIdempotencyKeyFromReq(req);
            const resource = await dataAdapter.findByIdempotencyKey(
                idempotencyKey!
            );
            assert.ok(resource);

            // All sensitive headers should be filtered
            assert.isUndefined(resource.request.headers.authorization);
            assert.isUndefined(resource.request.headers['proxy-authorization']);
            assert.isUndefined(resource.request.headers.cookie);
            assert.isUndefined(resource.request.headers['set-cookie']);
            assert.isUndefined(resource.request.headers['x-auth-token']);
            assert.isUndefined(resource.request.headers['x-csrf-token']);
            assert.isUndefined(resource.request.headers['x-xsrf-token']);

            // Non-sensitive headers should be preserved
            assert.equal(
                resource.request.headers['content-type'],
                'application/json'
            );
            assert.equal(resource.request.headers.accept, 'application/json');
        });

        it('filters headers with x-auth- prefix', async () => {
            const req = httpMocks.createRequest({
                url: 'https://test',
                method: 'POST',
                headers: {
                    'idempotency-key': faker.string.uuid(),
                    'x-auth-custom': 'secret',
                    'x-auth-bearer': 'token',
                    'x-custom-header': 'safe-value',
                },
            });

            const nextSpy = sinon.spy();
            await idempotencyService.provideMiddlewareFunction(
                req,
                httpMocks.createResponse(),
                nextSpy
            );

            const idempotencyKey =
                idempotencyService.extractIdempotencyKeyFromReq(req);
            const resource = await dataAdapter.findByIdempotencyKey(
                idempotencyKey!
            );
            assert.ok(resource);
            assert.isUndefined(resource.request.headers['x-auth-custom']);
            assert.isUndefined(resource.request.headers['x-auth-bearer']);
            assert.equal(
                resource.request.headers['x-custom-header'],
                'safe-value'
            );
        });

        it('filters headers with x-token- prefix', async () => {
            const req = httpMocks.createRequest({
                url: 'https://test',
                method: 'POST',
                headers: {
                    'idempotency-key': faker.string.uuid(),
                    'x-token-refresh': 'refresh123',
                    'x-token-access': 'access456',
                    'x-custom-header': 'safe-value',
                },
            });

            const nextSpy = sinon.spy();
            await idempotencyService.provideMiddlewareFunction(
                req,
                httpMocks.createResponse(),
                nextSpy
            );

            const idempotencyKey =
                idempotencyService.extractIdempotencyKeyFromReq(req);
            const resource = await dataAdapter.findByIdempotencyKey(
                idempotencyKey!
            );
            assert.ok(resource);
            assert.isUndefined(resource.request.headers['x-token-refresh']);
            assert.isUndefined(resource.request.headers['x-token-access']);
            assert.equal(
                resource.request.headers['x-custom-header'],
                'safe-value'
            );
        });

        it('filters headers with x-secret- prefix', async () => {
            const req = httpMocks.createRequest({
                url: 'https://test',
                method: 'POST',
                headers: {
                    'idempotency-key': faker.string.uuid(),
                    'x-secret-key': 'secret123',
                    'x-custom-header': 'safe-value',
                },
            });

            const nextSpy = sinon.spy();
            await idempotencyService.provideMiddlewareFunction(
                req,
                httpMocks.createResponse(),
                nextSpy
            );

            const idempotencyKey =
                idempotencyService.extractIdempotencyKeyFromReq(req);
            const resource = await dataAdapter.findByIdempotencyKey(
                idempotencyKey!
            );
            assert.ok(resource);
            assert.isUndefined(resource.request.headers['x-secret-key']);
            assert.equal(
                resource.request.headers['x-custom-header'],
                'safe-value'
            );
        });

        it('filters headers with x-key- prefix', async () => {
            const req = httpMocks.createRequest({
                url: 'https://test',
                method: 'POST',
                headers: {
                    'idempotency-key': faker.string.uuid(),
                    'x-key-api': 'apikey123',
                    'x-custom-header': 'safe-value',
                },
            });

            const nextSpy = sinon.spy();
            await idempotencyService.provideMiddlewareFunction(
                req,
                httpMocks.createResponse(),
                nextSpy
            );

            const idempotencyKey =
                idempotencyService.extractIdempotencyKeyFromReq(req);
            const resource = await dataAdapter.findByIdempotencyKey(
                idempotencyKey!
            );
            assert.ok(resource);
            assert.isUndefined(resource.request.headers['x-key-api']);
            assert.equal(
                resource.request.headers['x-custom-header'],
                'safe-value'
            );
        });

        it('filters sensitive headers case-insensitively', async () => {
            const req = httpMocks.createRequest({
                url: 'https://test',
                method: 'POST',
                headers: {
                    'idempotency-key': faker.string.uuid(),
                    Authorization: 'Bearer token',
                    COOKIE: 'session=123',
                    'X-API-KEY': 'key123',
                    'Content-Type': 'application/json',
                },
            });

            const nextSpy = sinon.spy();
            await idempotencyService.provideMiddlewareFunction(
                req,
                httpMocks.createResponse(),
                nextSpy
            );

            const idempotencyKey =
                idempotencyService.extractIdempotencyKeyFromReq(req);
            const resource = await dataAdapter.findByIdempotencyKey(
                idempotencyKey!
            );
            assert.ok(resource);
            // Express normalizes headers to lowercase, so check lowercase versions
            assert.isUndefined(resource.request.headers.authorization);
            assert.isUndefined(resource.request.headers.cookie);
            assert.isUndefined(resource.request.headers['x-api-key']);
            assert.equal(
                resource.request.headers['content-type'],
                'application/json'
            );
        });

        it('preserves safe headers while filtering sensitive ones', async () => {
            const req = httpMocks.createRequest({
                url: 'https://test',
                method: 'POST',
                headers: {
                    'idempotency-key': faker.string.uuid(),
                    authorization: 'Bearer secret',
                    'content-type': 'application/json',
                    'content-length': '123',
                    accept: 'application/json',
                    'user-agent': 'Test/1.0',
                    host: 'example.com',
                },
            });

            const nextSpy = sinon.spy();
            await idempotencyService.provideMiddlewareFunction(
                req,
                httpMocks.createResponse(),
                nextSpy
            );

            const idempotencyKey =
                idempotencyService.extractIdempotencyKeyFromReq(req);
            const resource = await dataAdapter.findByIdempotencyKey(
                idempotencyKey!
            );
            assert.ok(resource);

            // Sensitive header should be filtered
            assert.isUndefined(resource.request.headers.authorization);

            // Safe headers should be preserved
            assert.equal(
                resource.request.headers['content-type'],
                'application/json'
            );
            assert.equal(resource.request.headers['content-length'], '123');
            assert.equal(resource.request.headers.accept, 'application/json');
            assert.equal(resource.request.headers['user-agent'], 'Test/1.0');
            assert.equal(resource.request.headers.host, 'example.com');
        });

        it('handles empty headers object', async () => {
            const req = httpMocks.createRequest({
                url: 'https://test',
                method: 'POST',
                headers: {
                    'idempotency-key': faker.string.uuid(),
                },
            });

            const nextSpy = sinon.spy();
            await idempotencyService.provideMiddlewareFunction(
                req,
                httpMocks.createResponse(),
                nextSpy
            );

            const idempotencyKey =
                idempotencyService.extractIdempotencyKeyFromReq(req);
            const resource = await dataAdapter.findByIdempotencyKey(
                idempotencyKey!
            );
            assert.ok(resource);
            assert.isDefined(resource.request.headers);
        });
    });

    describe('Response header security', () => {
        it('preserves whitelisted content headers in cached response', async () => {
            const originalReq = createRequest();
            const firstReq = createCloneRequest(originalReq);
            const firstRes = httpMocks.createResponse();

            // Set whitelisted headers
            firstRes.setHeader('content-type', 'application/json');
            firstRes.setHeader('content-length', '100');
            firstRes.setHeader('content-encoding', 'gzip');

            await idempotencyService.provideMiddlewareFunction(
                firstReq,
                firstRes,
                sinon.spy()
            );
            firstRes.send({ data: 'test' });
            await wait(1);

            const secondReq = createCloneRequest(originalReq);
            const secondRes = httpMocks.createResponse();
            await idempotencyService.provideMiddlewareFunction(
                secondReq,
                secondRes,
                sinon.spy()
            );

            assert.equal(
                secondRes.getHeader('content-type'),
                'application/json'
            );
            assert.equal(secondRes.getHeader('content-length'), '100');
            assert.equal(secondRes.getHeader('content-encoding'), 'gzip');
        });

        it('filters temporal headers (cache-control, expires, etag, retry-after) from cached response', async () => {
            const originalReq = createRequest();
            const firstReq = createCloneRequest(originalReq);
            const firstRes = httpMocks.createResponse();

            // Set temporal headers that should NOT be cached
            firstRes.setHeader('content-type', 'application/json');
            firstRes.setHeader('cache-control', 'max-age=300');
            firstRes.setHeader('expires', 'Wed, 21 Oct 2025 07:28:00 GMT');
            firstRes.setHeader('etag', '"abc123"');
            firstRes.setHeader(
                'last-modified',
                'Wed, 21 Oct 2025 07:00:00 GMT'
            );
            firstRes.setHeader('vary', 'Accept-Encoding');
            firstRes.setHeader('retry-after', '120');

            await idempotencyService.provideMiddlewareFunction(
                firstReq,
                firstRes,
                sinon.spy()
            );
            firstRes.send({ data: 'test' });
            await wait(1);

            const secondReq = createCloneRequest(originalReq);
            const secondRes = httpMocks.createResponse();
            await idempotencyService.provideMiddlewareFunction(
                secondReq,
                secondRes,
                sinon.spy()
            );

            // Whitelisted header should be preserved
            assert.equal(
                secondRes.getHeader('content-type'),
                'application/json'
            );

            // Temporal headers should NOT be in cached response
            assert.isUndefined(secondRes.getHeader('cache-control'));
            assert.isUndefined(secondRes.getHeader('expires'));
            assert.isUndefined(secondRes.getHeader('etag'));
            assert.isUndefined(secondRes.getHeader('last-modified'));
            assert.isUndefined(secondRes.getHeader('vary'));
            assert.isUndefined(secondRes.getHeader('retry-after'));
        });

        it('preserves CORS headers in cached response', async () => {
            const originalReq = createRequest();
            const firstReq = createCloneRequest(originalReq);
            const firstRes = httpMocks.createResponse();

            firstRes.setHeader('access-control-allow-origin', '*');
            firstRes.setHeader('access-control-allow-methods', 'GET, POST');
            firstRes.setHeader('access-control-allow-headers', 'Content-Type');

            await idempotencyService.provideMiddlewareFunction(
                firstReq,
                firstRes,
                sinon.spy()
            );
            firstRes.send({ data: 'test' });
            await wait(1);

            const secondReq = createCloneRequest(originalReq);
            const secondRes = httpMocks.createResponse();
            await idempotencyService.provideMiddlewareFunction(
                secondReq,
                secondRes,
                sinon.spy()
            );

            assert.equal(
                secondRes.getHeader('access-control-allow-origin'),
                '*'
            );
            assert.equal(
                secondRes.getHeader('access-control-allow-methods'),
                'GET, POST'
            );
            assert.equal(
                secondRes.getHeader('access-control-allow-headers'),
                'Content-Type'
            );
        });

        it('preserves location header in cached response', async () => {
            const originalReq = createRequest();
            const firstReq = createCloneRequest(originalReq);
            const firstRes = httpMocks.createResponse();

            firstRes.setHeader('location', 'https://example.com/resource');

            await idempotencyService.provideMiddlewareFunction(
                firstReq,
                firstRes,
                sinon.spy()
            );
            firstRes.send({ data: 'test' });
            await wait(1);

            const secondReq = createCloneRequest(originalReq);
            const secondRes = httpMocks.createResponse();
            await idempotencyService.provideMiddlewareFunction(
                secondReq,
                secondRes,
                sinon.spy()
            );

            assert.equal(
                secondRes.getHeader('location'),
                'https://example.com/resource'
            );
        });

        it('filters out non-whitelisted headers from cached response', async () => {
            const originalReq = createRequest();
            const firstReq = createCloneRequest(originalReq);
            const firstRes = httpMocks.createResponse();

            // Set both whitelisted and non-whitelisted headers
            firstRes.setHeader('content-type', 'application/json');
            firstRes.setHeader('x-custom-header', 'should-be-filtered');
            firstRes.setHeader('server', 'Express');
            firstRes.setHeader('x-powered-by', 'Node.js');

            await idempotencyService.provideMiddlewareFunction(
                firstReq,
                firstRes,
                sinon.spy()
            );
            firstRes.send({ data: 'test' });
            await wait(1);

            const secondReq = createCloneRequest(originalReq);
            const secondRes = httpMocks.createResponse();
            await idempotencyService.provideMiddlewareFunction(
                secondReq,
                secondRes,
                sinon.spy()
            );

            // Whitelisted header should be preserved
            assert.equal(
                secondRes.getHeader('content-type'),
                'application/json'
            );

            // Non-whitelisted headers should not be in cached response
            assert.isUndefined(secondRes.getHeader('x-custom-header'));
            assert.isUndefined(secondRes.getHeader('server'));
            assert.isUndefined(secondRes.getHeader('x-powered-by'));
        });

        it('filters sensitive response headers like set-cookie', async () => {
            const originalReq = createRequest();
            const firstReq = createCloneRequest(originalReq);
            const firstRes = httpMocks.createResponse();

            firstRes.setHeader('content-type', 'application/json');
            firstRes.setHeader('set-cookie', ['session=abc123; HttpOnly']);
            firstRes.setHeader('authorization', 'Bearer token');

            await idempotencyService.provideMiddlewareFunction(
                firstReq,
                firstRes,
                sinon.spy()
            );
            firstRes.send({ data: 'test' });
            await wait(1);

            const secondReq = createCloneRequest(originalReq);
            const secondRes = httpMocks.createResponse();
            await idempotencyService.provideMiddlewareFunction(
                secondReq,
                secondRes,
                sinon.spy()
            );

            // Whitelisted header should be preserved
            assert.equal(
                secondRes.getHeader('content-type'),
                'application/json'
            );

            // Sensitive headers should not be cached
            assert.isUndefined(secondRes.getHeader('set-cookie'));
            assert.isUndefined(secondRes.getHeader('authorization'));
        });

        it('handles response header whitelist case-insensitively', async () => {
            const originalReq = createRequest();
            const firstReq = createCloneRequest(originalReq);
            const firstRes = httpMocks.createResponse();

            // Express typically lowercases headers, but test robustness
            firstRes.setHeader('Content-Type', 'application/json');
            firstRes.setHeader('Cache-Control', 'no-cache');

            await idempotencyService.provideMiddlewareFunction(
                firstReq,
                firstRes,
                sinon.spy()
            );
            firstRes.send({ data: 'test' });
            await wait(1);

            const secondReq = createCloneRequest(originalReq);
            const secondRes = httpMocks.createResponse();
            await idempotencyService.provideMiddlewareFunction(
                secondReq,
                secondRes,
                sinon.spy()
            );

            // Headers should still be preserved despite case variations
            assert.isDefined(
                secondRes.getHeader('Content-Type') ||
                    secondRes.getHeader('content-type')
            );
        });
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
