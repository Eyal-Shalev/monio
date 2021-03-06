"use strict";

var { isFunction, curry, } = require("./lib/util.js");
var IO = require("./io.js");

module.exports = curry(IOEventStream);
module.exports.merge = merge;
module.exports.zip = zip;
module.exports.close = close;


// **************************

function IOEventStream(el,evtName,opts = {}) {
	var {
		bufferSize = 100,
		throwBufferOverflow = false,
		evtOpts = {},
	} = opts;

	return IO(() => {
		var prStack;
		var nextStack;
		var forceClosed = Symbol("force closed");
		var { pr: hasClosed, next: triggerClose, } = getDeferred();
		var ait = eventStream();
		var origReturn = ait.return;
		ait.return = itReturn;
		return ait;


		// ****************************

		function itReturn(...args) {
			var pr = origReturn.apply(ait,args);
			triggerClose(forceClosed);
			ait.return = origReturn;
			return pr;
		}

		async function *eventStream() {
			prStack = [];
			nextStack = [];

			// (lazily) setup event listener
			if (isFunction(el.addEventListener)) {
				el.addEventListener(evtName,handler,evtOpts);
			}
			else if (isFunction(el.addListener)) {
				el.addListener(evtName,handler);
			}
			else if (isFunction(el.on)) {
				el.on(evtName,handler);
			}

			try {
				while (true) {
					if (prStack.length == 0) {
						let { pr, next, } = getDeferred();
						prStack.push(pr);
						nextStack.push(next);
					}
					let res = await Promise.race([
						hasClosed,
						prStack.shift(),
					]);
					if (res == forceClosed) {
						return;
					}
					else {
						yield res;
					}
				}
			}
			finally {
				// remove event listener
				if (isFunction(el.removeEventListener)) {
					el.removeEventListener(evtName,handler,evtOpts);
				}
				else if (isFunction(el.removeListener)) {
					el.removeListener(evtName,handler);
				}
				else if (isFunction(el.off)) {
					el.off(evtName,handler);
				}
				prStack.length = nextStack.length = 0;
			}
		}

		function handler(evt) {
			if (nextStack.length > 0) {
				let next = nextStack.shift();
				next(evt);
			}
			else if (prStack.length < bufferSize) {
				let { pr, next, } = getDeferred();
				prStack.push(pr);
				next(evt);
			}
			else if (throwBufferOverflow) {
				let err = new Error("Event stream buffer overflow");
				err.evt = evt;
				throw err;
			}
		}
	});
}

function merge(...streams) {
	return IO(() => mergeStreams());


	// ****************************

	async function *mergeStreams() {
		try {
			while (true) {
				let prs = pullFromStreams(streams);

				// listening to any streams?
				if (prs.length > 0) {
					try {
						// last open stream?
						if (prs.length == 1) {
							let [ streamIdx, stream, res, ] = await prs[0];

							// stream closed?
							if (res.done) {
								// cleanup
								streams[streamIdx] = null;

								// complete iterator
								return;
							}
							else {
								// keep listening to the stream
								streams[streamIdx] = stream;
							}

							// send stream value out through iterator
							yield res.value;
						}
						// otherwise keep cycling through still-open streams
						else {
							let [ streamIdx, stream, res, ] = await Promise.race(prs);

							// remove stream from current position (but preserve indexing)
							// note: will be re-inserted if still open
							streams[streamIdx] = null;

							// stream still open?
							if (!res.done) {
								// re-insert it at the end for next iteration
								// (balanced round-robin scheduling)
								streams.push(stream);

								// send stream value out through iterator
								yield res.value;
							}
						}
					}
					catch (err) {
						// send exception out through iterator (closing it)
						return Promise.reject(err);
					}
				}
				// otherwise, we're done
				else {
					return;
				}
			}
		}
		finally {
			// force-close any remaining streams
			await close(streams);
		}
	}
}

function zip(...streams) {
	return IO(() => zipStreams());


	// ****************************

	async function *zipStreams() {
		try {
			while (true) {
				let prs = pullFromStreams(streams);

				// listening to any streams?
				if (prs.length > 0) {
					try {
						let vals = (
							(await Promise.all(prs))
							.reduce(
								function getStreamVals(list,val){
									var [ streamIdx, stream, res, ] = val;
									// stream closed?
									if (res.done) {
										// cleanup
										streams[streamIdx] = null;
										return list;
									}
									else {
										// keep listening to the stream
										streams[streamIdx] = stream;
										return [ ...list, res.value, ];
									}
								},
							[])
						);

						// any streams still open producing values?
						if (vals.length > 0) {
							yield vals;
						}
						else {
							// complete iterator
							return;
						}
					}
					catch (err) {
						// send exception out through iterator (closing it)
						return Promise.reject(err);
					}
				}
				// otherwise, we're done
				else {
					return;
				}
			}
		}
		finally {
			// force-close any remaining streams
			await close(...streams).run();
		}
	}
}

function pullFromStreams(streams) {
	return (
		streams
		.map(function callIter(v,idx){
			// stream (iterator) waiting for its
			// next() call?
			if (v && isFunction(v.next)) {
				streams[idx] = (async function getNext(){
					var pr = v.next();
					try {
						let res = await pr;
						// store normal iterator result
						return (
							streams[idx] = [ idx, v, res, ]
						);
					}
					catch (err) {
						// clear slot on exception
						streams[idx] = null;
						return pr;
					}
				})();
				return streams[idx];
			}

			// otherwise, keep value untouched
			return v;
		})
		// remove any empty values
		.filter(Boolean)
	);
}

function close(...streams) {
	return IO(() => (
		Promise.all(streams.map(async function closeStream(stream){
			if (stream && isFunction(stream.return)) {
				try {
					return await stream.return();
				}
				catch (err) {}
			}
		}))
	));
}

function getDeferred() {
	var next;
	var pr = new Promise(res => next = res);
	return { pr, next, };
}
