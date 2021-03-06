"use strict";

var { isFunction, isPromise, isMonad, } = require("./lib/util.js");
var IO = require("./io.js");
var Maybe = require("./maybe.js");
var Either = require("./either.js");

var returnedValues = new WeakSet();

module.exports.applyIO = applyIO;
module.exports.doIO = doIO;
module.exports.doIOBind = doIOBind;
module.exports.filterIOList = filterIOList;
module.exports.concatIOList = concatIOList;
module.exports.iif = iif;
module.exports.elif = elif;
module.exports.els = els;
module.exports.iNot = iNot;
module.exports.iReturn = iReturn;
module.exports.wasReturned = wasReturned;


// **************************

function applyIO(io,env) {
	return IO(() => io.run(env));
}

function doIO(fn,...args) {
	return (
		(args.length > 0) ?
			IO(env => IO.do(fn(env,...args)).run(env)) :
			IO.do(fn)
	);
}

function doIOBind(fn,env) {
	var fnDoIO = IO(() => IO.do(fn).run(env));
	return (
		(...args) => (
			(args.length > 0) ?
				IO(() => (
					IO.do(fn(env,...args)).run(env))
				) :
				fnDoIO
		)
	);
}

function filterIOList(predicateIO,list) {
	return list.reduce(
		(io,el) => io.chain(list => (
			predicateIO(el)
			.map(include => (
				include ? [ ...list, el, ] : list
			))
		)),
		IO.of([])
	);
}

function concatIOList(list) {
	return list.reduce(
		(io,v) => io.map(list => [ ...list, v, ]),
		IO.of([])
	)
}

function iif(cond,thens,...elses) {
	return IO(env => {
		return (
			// evaluate the if-conditional expression
			liftIO(env,cond)
			.chain(doThens)
			.chain(doNextElse(elses))
			.run(env)
		);


		// ******************************

		// process (or skip) the "thens" based on the
		// if-conditional expression results
		function doThens(res) {
			// did the if-conditional "expression" resolve to truthy?
			if (res) {
				// process the "thens"
				return (
					// lift "thens" to an array if not already
					(Array.isArray(thens) ? thens : [thens])
					// IO-lift each "then" and chain them all
					// together
					.reduce(
						(io,then) => io.chain(v => (
							liftIO(env,v).chain(v => (
								returnedValues.has(v) ?
									IO.of(v) :
									liftIO(env,then)
							))
						)),
						IO.of()
					)
					// final "result" of the "thens" handling
					// should be the "return" value (if set)
					// or the result of the if-conditional
					// expression
					.chain(v => (
						liftIO(env,v).chain(v => (
							IO.of(
								returnedValues.has(v) ? v : res
							)
						))
					))
				);
			}
			else {
				return IO.of(res);
			}
		}

		// (recursively) handles the next else expression
		function doNextElse(elses) {
			// return a function to receive the results of
			// the previous if-conditional expression
			return (res => (
				// previous if-conditional result wasn't truthy,
				// and there's at least one more else expression
				// to try?
				(!res && elses.length > 0) ?
					// IO-lift the next else and chain onto it
					// the handling of the rest of the elses
					// (if any)
					liftIO(env,elses[0]).chain(
						doNextElse(elses.slice(1))
					) :
					// otherwise, short-circuit to "return"
					// the results of the previous conditional
					IO.of(res)
			));
		}
	});
}

function elif(cond,thens) {
	// NOTE: intentionally truncating to prevent confusing
	// nested "elses" expressions
	return iif(cond,thens);
}

function els(thens) {
	// if we get to a bare non-conditional "else", we treat
	// it like an "else if (true) .."
	return iif(true,thens);
}

function iReturn(val) {
	return IO(env => (
		liftIO(env,val)
		.map(v => {
			var ret = { returned: v, };
			returnedValues.add(ret);
			return ret;
		})
		.run(env)
	));
}

function iNot(val) {
	return IO(env => (
		liftIO(env,val)
		.map(v => !v)
		.run(env)
	));
}

function wasReturned(v) {
	return returnedValues.has(v);
}

function liftIO(env,v) {
	// monad?
	if (isMonad(v)) {
		// already an IO?
		if (IO.is(v)) {
			return v;
		}
		// Either:Left or Maybe:Nothing?
		else if (Either.Left.is(v) || Maybe.Nothing.is(v)) {
			// treat as an implicitly "early returned" value
			let ret = { returned: v, };
			returnedValues.add(ret);
			return IO.of(ret);
		}
		else {
			// attempt extracting value to "convert" to an IO
			let res = v.chain(IO.of);

			// did "converting" to an IO work?
			if (IO.is(res)) {
				return res;
			}
			// final fallback: wrap the monad in an IO
			else {
				return IO.of(v);
			}
		}
	}
	// non-monad function?
	else if (isFunction(v)) {
		return liftIO(env,v(env));
	}
	// iterator?
	else if (v && typeof v == "object" && isFunction(v.next)) {
		return IO.do(v);
	}
	// fallback: wrap whatever value this is in an IO
	else {
		return IO.of(v);
	}
}
