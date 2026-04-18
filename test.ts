import { genUnique64string, generateAPIKEY  } from 'shared/util/idgen.js';
let id = genUnique64string({ datacenter: 0, worker: 0 });
let apikey = generateAPIKEY();
console.log(id);
console.log(apikey);
