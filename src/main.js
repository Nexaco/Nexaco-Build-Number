const https = require('https'),
    zlib = require('zlib'),
    fs = require('fs'),
    core = require('@actions/core');
env = process.env;

function fail(message, exitCode = 1) {
    console.log(`::error::${message}`);
    process.exit(1);
}

function request(method, path, data, callback) {

    try {
        if (data) {
            data = JSON.stringify(data);
        }
        const options = {
            hostname: 'api.github.com',
            port: 443,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data ? data.length : 0,
                'Accept-Encoding': 'gzip',
                'Authorization': `token ${env.INPUT_TOKEN}`,
                'User-Agent': 'GitHub Action - development'
            }
        }
        const req = https.request(options, res => {

            let chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                let buffer = Buffer.concat(chunks);
                if (res.headers['content-encoding'] === 'gzip') {
                    zlib.gunzip(buffer, (err, decoded) => {
                        if (err) {
                            callback(err);
                        } else {
                            callback(null, res.statusCode, decoded && JSON.parse(decoded));
                        }
                    });
                } else {
                    callback(null, res.statusCode, buffer.length > 0 ? JSON.parse(buffer) : null);
                }
            });

            req.on('error', err => callback(err));
        });

        if (data) {
            req.write(data);
        }
        req.end();
    } catch (err) {
        callback(err);
    }
}

function writeToFile(filePath, content) {
    fs.appendFileSync(filePath, `${content}\n`);
}

function main() {

    const path = 'BUILD_NUMBER/BUILD_NUMBER';
    const prefix = env.INPUT_PREFIX ? `${env.INPUT_PREFIX}-` : '';

    //See if we've already generated the build number and are in later steps...
    if (fs.existsSync(path)) {
        let buildNumber = fs.readFileSync(path, 'utf8');
        console.log(`Build number already generated in earlier jobs, using build number ${buildNumber}...`);

        //Setting the output and environment variable to new build number...
        writeToFile(process.env.GITHUB_ENV, `BUILD_NUMBER=${buildNumber}`);
        writeToFile(process.env.GITHUB_OUTPUT, `build_number=${buildNumber}`);

        return;
    }

    //Some sanity checking:
    for (let varName of ['INPUT_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_SHA']) {
        if (!env[varName]) {
            fail(`ERROR: Environment variable ${varName} is not defined.`);
        }
    }

    request('GET', `/repos/${env.GITHUB_REPOSITORY}/git/refs/tags/${prefix}build-number-`, null, (err, status, result) => {

        let nextBuildNumber, nrTags;

        if (status === 404) {
            console.log('No build-number ref available, starting at 1.');
            nextBuildNumber = 1;
            nrTags = [];
        } else if (status === 200) {
            const regexString = `/${prefix}build-number-(\\d+)$`;
            const regex = new RegExp(regexString);
            nrTags = result.filter(d => d.ref.match(regex));

            const MAX_OLD_NUMBERS = 5;
            if (nrTags.length > MAX_OLD_NUMBERS) {
                fail(`ERROR: Too many ${prefix}build-number- refs in repository, found ${nrTags.length}, expected only 1. Check your tags!`);
            }

            let nrs = nrTags.map(t => parseInt(t.ref.match(/-(\d+)$/)[1]));
            let currentBuildNumber = Math.max(...nrs);
            console.log(`Last build nr was ${currentBuildNumber}.`);

            nextBuildNumber = currentBuildNumber + 1;
            console.log(`Updating build counter to ${nextBuildNumber}...`);
        } else {
            if (err) {
                fail(`Failed to get refs. Error: ${err}, status: ${status}`);
            } else {
                fail(`Getting build-number refs failed with http status ${status}, error: ${JSON.stringify(result)}`);
            }
        }

        let newRefData = {
            ref: `refs/tags/${prefix}build-number-${nextBuildNumber}`,
            sha: env.GITHUB_SHA
        };

        request('POST', `/repos/${env.GITHUB_REPOSITORY}/git/refs`, newRefData, (err, status, result) => {
            if (status !== 201 || err) {
                fail(`Failed to create new build-number ref. Status: ${status}, err: ${err}, result: ${JSON.stringify(result)}`);
            }

            console.log(`[v.2.1] Successfully updated build number to ${nextBuildNumber}`);

            //Setting the output and environment variable to new build number...
            writeToFile(process.env.GITHUB_ENV, `BUILD_NUMBER=${nextBuildNumber}`);
            writeToFile(process.env.GITHUB_OUTPUT, `build_number=${nextBuildNumber}`);

            //Save to file so it can be used for next jobs...
            fs.writeFileSync('BUILD_NUMBER', nextBuildNumber.toString());

            //Cleanup
            if (nrTags) {
                console.log(`Deleting ${nrTags.length} older build counters...`);

                for (let nrTag of nrTags) {
                    request('DELETE', `/repos/${env.GITHUB_REPOSITORY}/git/${nrTag.ref}`, null, (err, status, result) => {
                        if (status !== 204 || err) {
                            console.warn(`Failed to delete ref ${nrTag.ref}, status: ${status}, err: ${err}, result: ${JSON.stringify(result)}`);
                        } else {
                            console.log(`Deleted ${nrTag.ref}`);
                        }
                    });
                }
            }

        });
    });
}

main();
