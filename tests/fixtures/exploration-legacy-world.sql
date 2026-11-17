-- Captured with WorldStore at 42bea241; synthetic pilot credential, no production data.
CREATE TABLE world (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
INSERT INTO world(id,json) VALUES('1','{"seed":83,"startedAt":10000,"generation":1,"exploration":[{"id":"30,30","bits":"0300000000000000000000000000000000000000000000000000000000000000"},{"id":"7,12","bits":"0000000000000000000000000000000000000000000000000000000000000080"}],"civicModules":[{"id":"street-1-0","builderName":"Crew"}]}');
CREATE TABLE sectors (id TEXT PRIMARY KEY, json TEXT NOT NULL);
INSERT INTO sectors(id,json) VALUES('0,0','[]');
CREATE TABLE economy (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
INSERT INTO economy(id,json) VALUES('1','{"settlement":{"level":3,"points":440,"resources":{"ice":11,"metal":22,"rubble":33,"crystal":4}},"pointLoot":[{"id":"recoverable-bank","position":{"x":120,"y":80},"points":315,"expiresAt":130000}]}');
CREATE TABLE pilots (id TEXT PRIMARY KEY, json TEXT NOT NULL);
INSERT INTO pilots(id,json) VALUES('pilot','{"id":"pilot","tokenHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"Captain","score":7300,"cargo":715,"purchases":[]}');
