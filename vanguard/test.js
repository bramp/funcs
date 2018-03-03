/**
 * Copyright 2018 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const test = require('ava');
const sinon = require('sinon');
const parseString = require('xml2js').parseString;
import { mockReq, mockRes } from 'sinon-express-mock';

const rewire = require('rewire');
const funcs = rewire('.');

// Mock the axios instance.
const instance = {
  get: sinon.stub().resolves(null)// .returns(ret);
}
funcs.__set__('instance', instance);

test('vanguard: should return a error when fund is missing', (t) => {
  // Initialize mocks  
  const req = mockReq({url: '/'})
  const res = mockRes()

  // Call tested function
  funcs.vanguard(req, res);

  // Verify behavior of tested function
  t.true(res.send.calledOnce);
  t.deepEqual(res.status.lastCall.args, [412]);
  t.deepEqual(res.set.lastCall.args, ['Content-Type', 'text/xml']);

  parseString(res.send.lastCall.args, function (err, result) {
    t.deepEqual(result.error.message[0], 'Missing fund');
  });
});

test('vanguard: fetch fund', (t) => {
  // Initialize mocks  
  const req = mockReq({url: '/1234'})
  const res = mockRes()

  //var mock = sinon.mock(myAPI);
  //mock.expects("method").once().throws();

  // Call tested function
  funcs.vanguard(req, res);

  // Verify behavior of tested function
  t.true(res.send.calledOnce);
  t.deepEqual(res.status.lastCall.args, [200]);
  t.deepEqual(res.set.lastCall.args, ['Content-Type', 'text/xml']);

  parseString(res.send.lastCall.args, function (err, result) {
    t.deepEqual(result.error.message[0], 'Missing fund');
  });
});
