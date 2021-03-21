const { genUnique64string, generateAPIKEY } = require('fsg-shared/util/idgen');

let id = genUnique64string({ datacenter: 0, worker: 0 });
let apikey = generateAPIKEY();
console.log(id);
console.log(apikey);
