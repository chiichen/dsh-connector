# Changelog

## [0.2.0](https://github.com/chiichen/dsh-connector/compare/dsh-connector-plugin-v0.1.0...dsh-connector-plugin-v0.2.0) (2026-11-27)


### Features

* **dsh-connector-plugin:** add a settings page for the nine connectors ([615e19d](https://github.com/chiichen/dsh-connector/commit/615e19d992280fd8b276c8cf5312ef92c6f9e496))
* **dsh-connector-plugin:** add agent tool bridge and HTTP webhook router ([72b4c31](https://github.com/chiichen/dsh-connector/commit/72b4c314964998c1b71a530ccf52f5cd02cf2b3e))
* **dsh-connector-plugin:** add bidirectional context store, DSH schema compiler, and reliability primitives ([3bde9aa](https://github.com/chiichen/dsh-connector/commit/3bde9aae964d0c0fec03cc6dfa345be7b841e1d7))
* **dsh-connector-plugin:** implement session driver and multi-connector context routing manager ([8860ada](https://github.com/chiichen/dsh-connector/commit/8860adaa0a318ea211385dda230c92e440390b29))
* **dsh-connector-plugin:** start inbound sessions in a chosen workspace ([#17](https://github.com/chiichen/dsh-connector/issues/17)) ([40e038e](https://github.com/chiichen/dsh-connector/commit/40e038e7f0fa3c9d7e825377a800b35e56cac8eb))
* **dsh-connector-plugin:** wire Cordis bundle entry, storage integration, and e2e tests ([dcd9baf](https://github.com/chiichen/dsh-connector/commit/dcd9baf3b254bc3af22d161a3340cfb728a28370))
* reuse quoted context id or key by message id ([#20](https://github.com/chiichen/dsh-connector/issues/20)) ([819be6e](https://github.com/chiichen/dsh-connector/commit/819be6e5274b74e95c8cc8f547b83d21a29f5b39))


### Bug Fixes

* **dsh-connector-plugin:** compile settings CSS with tsdown ([ac7d5ff](https://github.com/chiichen/dsh-connector/commit/ac7d5ff4e855829fd0b623fd5f3c0e9582195240))
* **dsh-connector-plugin:** default WeCom inbound delivery to queue ([e35c787](https://github.com/chiichen/dsh-connector/commit/e35c787c82246da216f76c029d3f56d04cfce7f8))
* **dsh-connector-plugin:** default WeCom to the AI bot long connection ([9df49c1](https://github.com/chiichen/dsh-connector/commit/9df49c17c67a8dd94483b748fd7a398e1a90b7e0))
* **dsh-connector-plugin:** install settings CSS on the published dsh host ([f839ce3](https://github.com/chiichen/dsh-connector/commit/f839ce31421ed671b8aca10d593b770b7f8a8508))
* **dsh-connector-plugin:** install settings styles through DSH module metadata ([2e62d6d](https://github.com/chiichen/dsh-connector/commit/2e62d6dd3e3bf1a33c118b80acc32127bc10ee8b))
* **dsh-connector-plugin:** persist connector settings across reopen ([ccb95b6](https://github.com/chiichen/dsh-connector/commit/ccb95b621164a7c9d4e6b5b47871a29a22c6735c))
* **dsh-connector-plugin:** return a Cordis disposer from apply ([b1161c2](https://github.com/chiichen/dsh-connector/commit/b1161c2e977fac53f8b22818d38d556fbe85e321))
* **dsh-connector-plugin:** route connector logs through ctx.logger ([854e640](https://github.com/chiichen/dsh-connector/commit/854e640a124df8996999b332b59478578f8ca019))
* **dsh-connector-plugin:** scope inbound dedup keys per context hash and validate live session ([12fff2a](https://github.com/chiichen/dsh-connector/commit/12fff2a0c29fe70b841473447c778b44e97027cf))
* **dsh-connector-plugin:** select a named default for every enum ([043b6fc](https://github.com/chiichen/dsh-connector/commit/043b6fc9380cea3b51610bf52c90af789b938b1f))
* **dsh-connector-plugin:** theme the save button and group WeCom credentials ([ff42b4a](https://github.com/chiichen/dsh-connector/commit/ff42b4abdc2c0da0788a5290980ae0108f6850c2))
