'use strict';

const { Contract } = require('fabric-contract-api');

/**
 * AttendanceContract — Hyperledger Fabric Chaincode
 * Each record stores: studentHash, studentName, status, timestamp
 */
class AttendanceContract extends Contract {

    async InitLedger(ctx) {
        console.info('Attendance ledger initialized.');
    }

    // Mark attendance — called by backend gateway on each RFID scan
    async MarkAttendance(ctx, studentHash, studentName, status) {
        if (!studentHash || studentHash.trim() === '') {
            throw new Error('studentHash is required.');
        }

        const timestamp = new Date().toISOString();
        const recordId  = `ATT_${Date.now()}_${studentHash.substring(0, 8)}`;

        const record = {
            docType     : 'attendance',
            studentHash : studentHash.trim(),
            studentName : (studentName || 'Unknown').trim(),
            status      : (status      || 'Unknown').trim(),
            timestamp   : timestamp
        };

        await ctx.stub.putState(recordId, Buffer.from(JSON.stringify(record)));

        // Emit event for real-time off-chain listeners
        ctx.stub.setEvent('AttendanceMarked', Buffer.from(JSON.stringify({
            recordId, ...record
        })));

        console.info(`Record committed: ${recordId}`);
        return JSON.stringify({ recordId, ...record });
    }

    // Fetch all records from ledger, sorted newest first
    async GetAllRecords(ctx) {
        const allResults = [];
        const iterator   = await ctx.stub.getStateByRange('', '');
        let result       = await iterator.next();

        while (!result.done) {
            const strValue = Buffer.from(result.value.value.toString()).toString('utf8');
            let record;
            try   { record = JSON.parse(strValue); }
            catch { record = strValue; }

            if (record.docType === 'attendance') {
                allResults.push({ Key: result.value.key, Record: record });
            }
            result = await iterator.next();
        }

        allResults.sort((a, b) =>
            new Date(b.Record.timestamp) - new Date(a.Record.timestamp)
        );
        return JSON.stringify(allResults);
    }

    // Get all records for a specific student by hash
    async GetRecordsByStudent(ctx, studentHash) {
        if (!studentHash || studentHash.trim() === '') throw new Error('studentHash required.');
        const all      = JSON.parse(await this.GetAllRecords(ctx));
        const filtered = all.filter(i => i.Record.studentHash === studentHash.trim());
        return JSON.stringify(filtered);
    }

    // Attendance summary: count + lastSeen per student
    async GetAttendanceSummary(ctx) {
        const all     = JSON.parse(await this.GetAllRecords(ctx));
        const summary = {};
        for (const item of all) {
            const key = item.Record.studentHash;
            if (!summary[key]) {
                summary[key] = { studentHash: item.Record.studentHash, studentName: item.Record.studentName, count: 0, lastSeen: '' };
            }
            summary[key].count++;
            if (!summary[key].lastSeen || item.Record.timestamp > summary[key].lastSeen) {
                summary[key].lastSeen = item.Record.timestamp;
            }
        }
        return JSON.stringify(Object.values(summary).sort((a, b) => b.count - a.count));
    }
}

module.exports = AttendanceContract;
