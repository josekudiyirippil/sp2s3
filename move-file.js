module.exports = function (args) {

    const fs = require('fs')
    const httpntlm = require('httpntlm')
    const spUrl = args.options['sp-url'] || process.env.SP_URL
    const spUser = args.options['sp-user'] || process.env.SP_USER
    const spDomain = args.options['sp-domain'] || process.env.SP_DOMAIN
    const spPassword = args.options['sp-password'] || process.env.SP_PASSWORD
    const s3Bucket = args.options['s3-bucket'] || process.env.S3_BUCKET
    const s3PathPrefix = args.options['s3-path-prefix'] || process.env.S3_PATH_PREFIX
    const awsAccessKeyId = args.options['aws-access-key-id'] || process.env.AWS_ACCESS_KEY_ID
    const awsSecretAccessKey = args.options['aws-secret-access-key'] || process.env.AWS_SECRET_ACCESS_KEY
    const concurrency = args.options['concurrency'] || process.env.CONCURRENCY || 10

    const AWS = require('aws-sdk')
    AWS.config.update({
        accessKeyId: awsAccessKeyId,
        secretAccessKey: awsSecretAccessKey
    })
    const s3 = new AWS.S3({ apiVersion: '2018-06-21' })

    const spWebUrl = spUrl.substring(0, spUrl.toLowerCase().indexOf('/_vti_bin'))
    const queue = require('async/queue')

    return function () {
        console.info('started processing')
        httpntlm.get({
            url: spUrl,
            username: spUser,
            password: spPassword,
            domain: spDomain
        }, function (err, res) {
            if (err) {
                console.error(`error getting file list: ${err}`)
                return err
            }
            let parseString = require('xml2js').parseString
            parseString(res.body, (err, result) => {
                let q = queue(function (e, cb) {
                    try {
                        httpntlm.get({
                            url: e.content[0].$.src,
                            username: spUser,
                            password: spPassword,
                            domain: spDomain,
                            binary: true
                        }, function (err, response) {
                            if (err) {
                                console.error(`error getting file ${e.content[0].$.src}: ${err}`)
                                return cb(err)
                            }
                            let filePath = e.content[0].$.src.substring(spWebUrl.length + 1)
                            let fileName = decodeURIComponent(filePath.substring(filePath.indexOf('/') + 1))
                            s3.upload({
                                Bucket: s3Bucket,
                                Key: s3PathPrefix + `/${fileName}`,
                                Body: response.body
                            }, function (err, data) {
                                if (err) {
                                    console.error(`error uploading file ${fileName}: ${err}`)
                                    return cb(err)
                                }
                                // delete sp file
                                httpntlm.delete({
                                    url: e.id[0],
                                    username: spUser,
                                    password: spPassword,
                                    domain: spDomain,
                                }, function (err, res) {
                                    if (err) {
                                        console.error(`error deleting file ${fileName}: ${err}`)
                                        return cb(err)
                                    }
                                    console.info(`successfully deleted file ${fileName}`)
                                    return cb()
                                })
                            })
                        })
                    }
                    catch (ex) {
                        console.error(`caught exception: ${ex}`)
                        return cb(ex)
                    }
                }, concurrency)
                q.drain = function () {
                    console.info('finished processing')
                }
                let queuedTasks = []
                result.feed.entry && result.feed.entry.forEach(e => {
                    try {
                        if (e["m:properties"][0]["d:ContentType"][0] !== "Document") {
                            // skip non-document items such as folders
                            return
                        }
                        queuedTasks.push(e)
                    }
                    catch (ex) {
                    }
                })
                q.push(queuedTasks)
            })
        })
    }
}
